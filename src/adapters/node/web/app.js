// 占位脚本：批 B 正式前端以原生 ESM 交付，零构建零依赖零外链。
// token 引导注入（nonce CSP）在批 B 接入时由 GET /  bootstrap 提供，本占位不发起鉴权请求。
const note = document.getElementById('boot-note');
if (note) {
  note.textContent = `前端骨架占位中 · ${new Date().toISOString()}（批 A 观测 API 已就绪）`;
}
