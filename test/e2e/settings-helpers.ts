// Follow the settings migration in browser regressions without restoring the
// removed header refresh control or collaboration-environment tab.
import { expect, type Page, type FrameLocator } from '@playwright/test';
type Surface = Page | FrameLocator;
export async function openSettings(surface: Surface) {
  if (!await surface.getByRole('dialog', { name: /^(设置|Settings)$/ }).isVisible()) await surface.getByRole('button', { name: /^(设置|Settings)$/ }).click();
}
export async function closeSettings(surface: Surface) {
  const dialog = surface.getByRole('dialog', { name: /^(设置|Settings)$/ });
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: /^(关闭设置|Close settings)$/ }).click();
}
export async function refreshBoard(surface: Surface) {
  const opened = !await surface.getByRole('dialog', { name: /^(设置|Settings)$/ }).isVisible();
  await openSettings(surface); await surface.getByRole('button', { name: /^(重新读取设置|Reload settings)$/ }).click();
  // Await the real board response through the UI's completed reload count.
  await expect(surface.getByRole('button', { name: /^(重新读取设置|Reload settings)$/ })).toBeEnabled();
  if (opened) await closeSettings(surface);
}
