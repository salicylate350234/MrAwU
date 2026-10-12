const { createRequire } = require('node:module');
const req = createRequire(__filename);
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { createCanvas } = req(path.join(ROOT, 'node_modules/@napi-rs/canvas'));
const sceneLib = req(path.join(ROOT, 'lib/scene.js'));
const simLib = req(path.join(ROOT, 'lib/sim.js'));
const drawLib = req(path.join(ROOT, 'lib/draw.js'));
const planck = req(path.join(ROOT, 'vendor/planck.min.js'));
const models = req(path.join(ROOT, 'lib/models/index.js'));

const id = process.argv[2] || 'plankPush';
const t = Number(process.argv[3] || 1);
const target = process.argv[4] || '5fa8ff';   // 木板的填充色
const model = models.get(id);
const params = models.defaults(model);
const scene = models.scene(id, params, sceneLib);
scene.view.width = 1000; scene.view.height = 560;
const res = simLib.createSim(planck, scene).record();
const frames = res.frames;
const view = drawLib.makeView(frames, scene);
let fi = 0, bd = 1e9;
frames.forEach((f, i) => { const d = Math.abs(f.t - t); if (d < bd) { bd = d; fi = i; } });
const canvas = createCanvas(1000, 560);
const ctx = canvas.getContext('2d');
drawLib.render(ctx, view, frames[fi], scene, { layers: { forces: true, velocity: true, grid: true, trail: true, dims: true }, labelMode: 'full' });
const img = ctx.getImageData(0, 0, 1000, 560).data;
const R = parseInt(target.slice(0, 2), 16), G = parseInt(target.slice(2, 4), 16), B = parseInt(target.slice(4, 6), 16);
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, n = 0;
for (let y = 0; y < 560; y++) for (let x = 0; x < 1000; x++) {
  const o = (y * 1000 + x) * 4;
  if (Math.abs(img[o] - R) < 12 && Math.abs(img[o + 1] - G) < 12 && Math.abs(img[o + 2] - B) < 12) {
    n++;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
}
console.log(`模型 ${id}  t=${frames[fi].t.toFixed(2)}s  取景 ${view.pxPerM.toFixed(1)} px/m`);
console.log(`颜色 #${target} 像素数 ${n}`);
if (n) console.log(`  包围盒: 宽 ${maxX - minX + 1} px × 高 ${maxY - minY + 1} px  (x ${minX}~${maxX}, y ${minY}~${maxY})`);
else console.log('  画面里找不到这个颜色的物体（可能被别的图形盖住或没画）');
// 顺带报一下两个刚体的实际屏幕尺寸
scene.bodies.filter(b => b.type === 'dynamic').forEach(b => {
  const fb = frames[fi].bodies[b.id];
  const bb = sceneLib.shapeBounds(b.shape);
  const wpx = (bb[1][0] - bb[0][0]) * view.pxPerM, hpx = (bb[1][1] - bb[0][1]) * view.pxPerM;
  console.log(`  ${b.id}: 真实尺寸 ${(bb[1][0] - bb[0][0]).toFixed(2)}m×${(bb[1][1] - bb[0][1]).toFixed(2)}m → 屏幕上 ${wpx.toFixed(0)}×${hpx.toFixed(0)} px`);
});
