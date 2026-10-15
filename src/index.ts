// This entrypoint starts only the local cooperation service; model sessions stay in their own harnesses.
import { pathToFileURL } from 'node:url';
import { startServer } from './app.js';
export { createApp, startServer } from './app.js';
export { Store, AppError } from './store.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rawPort = process.env.PORT ?? '4317';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535');
  const running = await startServer({port});
  console.log(`Swarmboard listening on ${running.url}`);
  let stopping = false;
  const stop = async()=>{if(stopping)return;stopping=true;await running.close();process.exit(0);};
  process.once('SIGINT',()=>{void stop();});process.once('SIGTERM',()=>{void stop();});
}
