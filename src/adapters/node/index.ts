/**
 * node 适配器导出面。
 *
 * 只导出机制与装配两件：`startHttpServer`（把已开门面以同源 HTTP 暴露）与
 * `serve`（组合根，读 env 一键起）。配置解析单列，便于测试与嵌入方按需组合。
 */

export { startHttpServer, type HttpServerOptions, type HttpServerHandle } from './http-server.ts';
export { serve } from './serve.ts';
export { readServeConfig, type ServeConfig } from './config.ts';
