import { loadConfig } from './config.js';
import { createApp, createHttpServer } from './app.js';
import { SupportService } from './support.js';
import { VisitCounter } from './counts.js';

const config = loadConfig();
const support = new SupportService(config);
const counts = new VisitCounter(config, config.visitCountsPath);
const server = createHttpServer(createApp(config, support, counts)).listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'refuge_open', network: config.network, chainId: config.chainId, port: config.port, counter: counts.snapshot().status }));
});
server.on('error', () => { console.error('Unable to start HTTP server.'); process.exitCode = 1; });
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close(() => { counts.close(); support.dispose(); process.exit(0); });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
