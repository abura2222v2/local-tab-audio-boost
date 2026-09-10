import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const requestedPort = Number(process.env.AUDIO_BOOST_TEST_PORT ?? 4173);
if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535) {
  throw new Error('AUDIO_BOOST_TEST_PORT must be an integer from 1 to 65535.');
}

const assetDefinitions = [
  ['/manual-audio.js', new URL('../manual-test/manual-audio.js', import.meta.url), 'text/javascript; charset=utf-8'],
  ['/manual-audio.css', new URL('../manual-test/manual-audio.css', import.meta.url), 'text/css; charset=utf-8'],
];

const assets = new Map(
  await Promise.all(
    assetDefinitions.map(async ([pathname, fileUrl, contentType]) => [
      pathname,
      { body: await readFile(fileUrl), contentType },
    ]),
  ),
);
const indexBody = await readFile(new URL('../manual-test/index.html', import.meta.url));

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const asset = assets.get(pathname);

  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; media-src blob:; object-src 'none'; base-uri 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');

  if (asset) {
    response.writeHead(200, { 'Content-Type': asset.contentType });
    response.end(asset.body);
    return;
  }
  if (pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }

  // Every other path serves the same document so saved SPA routes also work
  // when reloaded directly.
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(indexBody);
});

server.on('error', (error) => {
  console.error(`Manual test server failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

server.listen(requestedPort, '127.0.0.1', () => {
  console.log(`Manual test page: http://127.0.0.1:${requestedPort}/`);
  console.log('Press Ctrl+C to stop the server.');
});
