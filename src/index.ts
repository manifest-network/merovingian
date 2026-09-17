import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { SupportService } from './support.js';
import { VisitCounter } from './counts.js';

const config = loadConfig();
const support = new SupportService(config);
const counts = new VisitCounter(config, config.visitCountsPath);
const server = createApp(config, support, counts).listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'refuge_open', network: config.network, chainId: config.chainId, port: config.port }));
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.on('error', () => { console.error('Unable to start HTTP server.'); process.exitCode = 1; });
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close(() => { counts.close(); support.dispose(); process.exit(0); });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
