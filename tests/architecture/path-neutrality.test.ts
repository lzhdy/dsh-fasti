/**
 * 平台化 H2-b · 数据根路径去宿主化静态守卫。
 *
 * 目的：把「内核路径模块不内置任何宿主专属命名」这条边界物理钉死、防回潮。
 * src/source/paths.ts 中：
 *  - 不得出现引号字符串字面量 `.dsh`（旧宿主默认根路径段，兜底根已改 .fasti）；
 *  - 不得出现引号包裹的具体宿主通道 id `dsh`（目录布局靠装配方显式声明，不认识特定通道）。
 *
 * 历史环境变量 `DSH_HOME`（大写）是正本 §2.6 修正案③要求保留的只读兼容名，不在禁止列；
 * 注释中的裸文本同样不触发——本守卫只盯**字符串字面量**，避免误伤说明文字。
 * 只静态读源码文本做判定，不运行加载模块、不写入真实 src/。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PATHS_FILE = path.join(REPO_ROOT, 'src', 'source', 'paths.ts');

/** 旧宿主默认根路径段的字符串字面量（'.dsh'）。 */
const HOST_ROOT_SEGMENT = /["']\.dsh["']/;
/** 具体宿主通道 id 的字符串字面量（'dsh' 或 "dsh"）。 */
const HOST_CHANNEL_LITERAL = /["']dsh["']/;

test('H2-b 路径中立：paths.ts 不含宿主默认根 .dsh 与具体通道 id dsh 的字符串字面量', () => {
  assert.ok(fs.existsSync(PATHS_FILE), `前置失效：待守文件缺失：${PATHS_FILE}`);
  const text = fs.readFileSync(PATHS_FILE, 'utf8');
  assert.ok(text.length > 50, '前置失效：paths.ts 内容异常为空，检查路径');

  // 主断言：两类宿主字面量都不得出现。
  assert.doesNotMatch(text, HOST_ROOT_SEGMENT, '回潮：paths.ts 不得再内置宿主默认根 .dsh');
  assert.doesNotMatch(text, HOST_CHANNEL_LITERAL, '回潮：paths.ts 不得写死具体宿主通道 id dsh');

  // 正向锚点：中性变量必须在，历史兼容名也必须保留（防止一刀切误删兼容）。
  assert.ok(text.includes("'FASTI_HOME'"), '中性数据根变量 FASTI_HOME 应存在');
  assert.ok(text.includes("'DSH_HOME'"), '历史环境变量 DSH_HOME 应按修正案保留只读兼容');
  assert.ok(text.includes("'.fasti'"), '兜底默认根应为 .fasti');
});

test('H2-b 投毒自证：注入 .dsh 根段或 dsh 通道字面量必被当场标红（内存拼接，不写盘）', () => {
  const text = fs.readFileSync(PATHS_FILE, 'utf8');

  const rootPoison = `${text}\nreturn path.resolve(base, '.dsh', 'fasti');\n`;
  assert.match(rootPoison, HOST_ROOT_SEGMENT, '.dsh 根段投毒未标红');

  const channelPoison = `${text}\nreturn channel === 'dsh' ? layout.rawTurns : layout.raw;\n`;
  assert.match(channelPoison, HOST_CHANNEL_LITERAL, 'dsh 通道字面量投毒未标红');

  // 合规文本不误报：大写历史 env、裸注释、其它通道名都干净。
  for (const clean of [
    "const LEGACY_DSH_HOME_ENV = 'DSH_HOME';",
    '// 旧库位于 ~/.dsh ，经显式 dataRoot 只读打开（裸注释无引号字面量）',
    "path.join(layout.raw, 'qq');",
  ]) {
    assert.doesNotMatch(clean, HOST_ROOT_SEGMENT, `合规文本被误报：${clean}`);
    assert.doesNotMatch(clean, HOST_CHANNEL_LITERAL, `合规文本被误报：${clean}`);
  }
});
