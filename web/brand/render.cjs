const { chromium } = require('playwright');
(async () => {
  const [,, file, out, w, h, scale, full] = process.argv;
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: +(scale||1) });
  await p.goto('file://' + require('path').resolve(file));
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  await p.screenshot({ path: out, fullPage: full === 'full' });
  await b.close();
})();
