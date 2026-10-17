import express, { type ErrorRequestHandler, type Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AppError, Store } from './store.js';
import { createMcpServer } from './mcp.js';
import { defaultDatabasePath, defaultWidgetPath } from './paths.js';
import type { EventRuntime } from './event-runtime.js';

export interface AppOptions { store?: Store; dbPath?: string; widgetPath?: string; boardToken?: string; runtime?: EventRuntime }
export interface ServerOptions extends AppOptions { port?: number; host?: string }
export function createApp(options: AppOptions = {}) {
  const store = options.store ?? new Store(options.dbPath ?? defaultDatabasePath());
  const widgetPath = options.widgetPath ?? defaultWidgetPath();
  const boardToken = options.boardToken ?? process.env.BOARD_TOKEN;
  const app = express();
  app.disable('x-powered-by');
  app.locals.store = store;
  app.use((_req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');next();});
  app.use((req,res,next)=>{
    // Restrict unauthenticated local mode to loopback Host values and browser requests to this origin.
    const hostname = req.hostname?.toLowerCase() ?? '';
    if (!boardToken && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) {
      res.status(403).json({error:{code:'FORBIDDEN_HOST',message:'Local mode accepts only loopback hosts'}}); return;
    }
    const origin = req.headers.origin;
    if (origin) {
      try { if (new URL(origin).origin !== `${req.protocol}://${req.headers.host}`) throw new Error('origin mismatch'); }
      catch {res.status(403).json({error:{code:'FORBIDDEN_ORIGIN',message:'Cross-origin requests are not allowed'}});return;}
    }
    if (boardToken) {
      const supplied = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
      const a = Buffer.from(supplied); const b = Buffer.from(boardToken);
      if (a.length !== b.length || !timingSafeEqual(a,b)) {res.status(401).json({error:{code:'UNAUTHORIZED',message:'A valid board bearer token is required'}});return;}
    }
    next();
  });
  app.get('/health',(_req,res)=>res.json({ok:true}));
  app.use(express.json({limit:'128kb'}));
  app.get('/',(_req,res,next)=>res.sendFile(widgetPath,error=>{if(error)next(new AppError('UI_NOT_BUILT','Build the UI before opening the board',503));}));
  app.get('/api/runtime', (_req,res) => res.json(options.runtime?.status() ?? {mode:'events',workers:[],error:''}));
  app.get('/api/board',(_req,res)=>res.json(store.board()));
  const route = (method:'post'|'patch',path:string,operation:(req:Request)=>unknown)=>app[method](path,(req,res,next)=>{try{res.json(operation(req));}catch(error){next(error);}});
  route('post','/api/tasks',req=>store.createTask(req.body));
  route('patch','/api/tasks/:id',req=>store.updateTask(String(req.params.id),req.body));
  route('post','/api/tasks/:id/claim',req=>store.claimTask(String(req.params.id),req.body));
  route('post','/api/tasks/:id/release',req=>store.releaseTask(String(req.params.id),req.body));
  route('post','/api/resources',req=>store.createResource(req.body));
  route('patch','/api/resources/:id',req=>store.updateResource(String(req.params.id),req.body));
  route('post','/api/agents',req=>store.registerAgent(req.body));
  route('post','/api/agents/:id/heartbeat',req=>store.heartbeat(String(req.params.id)));
  route('post','/api/entries',req=>store.publishEntry(req.body));
  app.get('/api/entries',(req,res,next)=>{try{res.json(store.readEntries(req.query));}catch(error){next(error);}});
  route('post','/api/usages',req=>store.declareUsage(req.body));
  route('patch','/api/usages/:id',req=>store.updateUsage(String(req.params.id),req.body));
  route('post','/api/usages/:id/release',req=>store.releaseUsage(String(req.params.id),req.body));
  app.post('/mcp',async(req,res,next)=>{
    const mcp = createMcpServer(store,widgetPath,options.runtime);
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
    res.on('close',()=>{void transport.close();void mcp.close();});
    try {await mcp.connect(transport);await transport.handleRequest(req,res,req.body);}catch(error){if(!res.headersSent)next(error);}
  });
  app.all('/mcp',(_req,res)=>{res.setHeader('Allow','POST');res.status(405).json({error:{code:'METHOD_NOT_ALLOWED',message:'Use POST for the stateless MCP endpoint'}});});
  app.use((_req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'Endpoint not found'}}));
  const errors: ErrorRequestHandler = (error,_req,res,_next)=>{
    const known = error instanceof AppError;
    const malformed = error instanceof SyntaxError && 'body' in error;
    const tooLarge = error?.type === 'entity.too.large';
    const status = known ? error.status : malformed ? 400 : tooLarge ? 413 : 500;
    res.status(status).json({error:{code:known ? error.code : malformed ? 'VALIDATION_ERROR' : tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR',message:known ? error.message : malformed ? 'Malformed JSON body' : tooLarge ? 'Request body is too large' : 'Unable to complete operation'}});
  };
  app.use(errors);
  return app;
}
export async function startServer(options:ServerOptions = {}) {
  const store = options.store ?? new Store(options.dbPath ?? defaultDatabasePath());
  const app = createApp({...options,store});
  const host = options.host ?? '127.0.0.1'; const port = options.port ?? 4317;
  if (!['localhost','127.0.0.1','::1'].includes(host) && !(options.boardToken ?? process.env.BOARD_TOKEN)) {
    if (!options.store) store.close();
    throw new AppError('AUTH_REQUIRED', 'Non-loopback binding requires BOARD_TOKEN', 400);
  }
  let server: Server;
  try {
    server = await new Promise<Server>((resolve,reject)=>{const listener=app.listen(port,host,()=>resolve(listener));listener.once('error',reject);});
  } catch (error) {
    if (!options.store) store.close();
    throw error;
  }
  const address = server.address(); const actualPort = typeof address === 'object' && address ? address.port : port;
  return {app,server,store,url:`http://${host.includes(':') ? `[${host}]` : host}:${actualPort}`,close:async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve()));if(!options.store)store.close();}};
}
