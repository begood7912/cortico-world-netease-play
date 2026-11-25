/**
 * 打「发布用的干净包」：只拷代码和文档，不带你机器上的任何数据与私人配置。
 *
 * 用户口径（2026-11-25）：「所有的配置单独导出来，可以发布软件的时候，这些都不随发布，
 * 我这边所填的信息全部变成默认清空。」
 *
 * 所以：
 *   - 配置导出用 `_export_config.mjs`（单独一份 JSON，存在 F:\网易云陪听-私有\）
 *   - 发布包**不含** `data/`（歌单 ID、听歌流水、聊天回弹、天气缓存、接力状态全在那里面）
 *   - 发布包**不含** `node_modules/`、`*.wav`（合成缓存）、自测脚本 `_t_*.mjs` / `_bench_*.mjs` / `_export_config.mjs`
 *   - 发布包里所有键都走 `settings.schema.js` 的 DEFAULTS —— 新装打开就是干净的默认值
 *
 * 用法：node _make_release.mjs [输出根目录]
 *   默认 F:\网易云陪听-发布\
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = '.';
const OUT_ROOT = process.argv[2] || 'F:/AI点歌-发布';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const name = pkg.name;
const ver = pkg.version;
const target = join(OUT_ROOT, `${name}-${ver}-clean`);

/** 不进发布包的东西（相对路径前缀 / 通配）。 */
const SKIP_DIRS = ['node_modules', 'data', '.git', 'release'];
const SKIP_FILES = [
  '_export_config.mjs', '_make_release.mjs', '_bench_wx.mjs', '_restore_config.mjs',
  'debug.log', 'fastplay.log',
];
// 0.1.01（用户口径）：开发记录 / 历史改动日志一律不进初始发布版本 —— 已经在
// F:\coopanion-world-netease-play.bak-*\开发记录-后续\ 留着；这里再拦一道，防止以后又写回根目录。
const skipDoc = (n) => /^UPDATE-[^/]*\.md$/.test(n) || /^CHANGELOG-[^/]*\.md$/.test(n) || n === 'RUN-REQUIREMENTS.md';
const skipName = (n) => SKIP_FILES.includes(n) || skipDoc(n) || /^_t_[^/]*\.mjs$/.test(n) || /^_probe/.test(n) || /^_restore_config\.mjs$/.test(n) || /\.wav$/i.test(n);

function walk(dir, base, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    const rel = relative(base, abs).replaceAll('\\', '/');
    if (ent.isDirectory()) {
      if (SKIP_DIRS.includes(ent.name)) continue;
      walk(abs, base, out);
    } else if (!skipName(ent.name)) {
      out.push(rel);
    }
  }
  return out;
}

if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

const files = walk(ROOT, ROOT);
for (const rel of files) cpSync(join(ROOT, rel), join(target, rel), { recursive: false });

const bytes = files.reduce((s, f) => s + statSync(join(target, f)).size, 0);

/** 兜底检查：发布包里不许出现这些东西。 */
const banned = [];
const scan = (dir) => {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'data') banned.push('data/ 目录');
      scan(abs);
    } else {
      if (/\.wav$/i.test(ent.name)) banned.push(relative(target, abs));
      if (/embed-cache|playlists\.json|weather-cache|chain\.json|answer-log|listening\.jsonl/.test(ent.name)) banned.push(relative(target, abs));
    }
  }
};
scan(target);

/** 发布包里不该出现本机填过的值（拿宿主配置里那几项去撞）。 */
let leaked = [];
try {
  const host = JSON.parse(readFileSync('D:/Programs/Coopanion/data/home/companion/config.json', 'utf8'));
  const cfg = (host.worlds && host.worlds['netease-play']) || {};
  // 只查「真的私人」的值；openaiUrl / model 名这类是公开默认，出现在源码注释里不算泄漏
  const sensitive = ['qwApiKey', 'qwApiHost', 'qwCity', 'qwAdmin', 'playlist', 'chainCharts', 'clientExe', 'openaiKey'];
  for (const key of sensitive) {
    const v = String(cfg[key] == null ? '' : cfg[key]).trim();
    if (!v || v.length < 6) continue;
    for (const rel of files) {
      const p = join(target, rel);
      if (statSync(p).size > 2 * 1024 * 1024) continue;
      if (!/\.(json|js|md|txt|css|html)$/i.test(rel)) continue;
      if (readFileSync(p, 'utf8').includes(v)) leaked.push(`${rel} 含 ${key}`);
    }
  }
} catch { /* 读不到宿主配置就不查这一项 */ }

const report = {
  name,
  version: ver,
  builtAt: new Date().toISOString(),
  files: files.length,
  bytes,
  excluded: {
    dirs: SKIP_DIRS,
    dirData: '整个 data/ 不发布：里面是歌单 ID、听歌流水、回弹日志、天气缓存、接力状态、合成 wav',
    scripts: '_t_*.mjs / _bench_*.mjs / _export_config.mjs / _make_release.mjs',
    files: SKIP_FILES,
  },
  bannedFound: banned,
  leakedConfigValues: leaked,
  configExport: 'F:/AI点歌-私有/（由 _export_config.mjs 生成，仅本机保存）',
};
writeFileSync(join(target, 'RELEASE-CHECK.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`发布包：${target}`);
console.log(`文件 ${files.length} 个 · ${(bytes / 1024).toFixed(0)} KB`);
console.log(`禁止项：${banned.length ? banned.join('、') : '无'}`);
console.log(`本机配置泄漏：${leaked.length ? leaked.join('；') : '无'}`);
if (banned.length || leaked.length) process.exitCode = 1;
