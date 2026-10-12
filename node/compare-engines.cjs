/*!
 * 双后端对拍：同一个场景分别用 planck 与自研 Verlet 跑，逐帧比对位置/速度/受力，
 * 并把临界量（共速时刻、最大相对滑动 = L_min）与解析解、planck 结果三方对比。
 *
 * 这是"换引擎"这条路唯一的护栏：自研路径的残差 ΣJ−Δp 是代数恒等式，
 * 不再构成独立验证，必须靠对拍才能发现受力分支写错。
 *
 * 用法：node node/compare-engines.cjs [--model plankPush] [--verbose]
 */
const path = require('node:path');
const { createRequire } = require('node:module');
const req = createRequire(__filename);
const ROOT = path.resolve(__dirname, '..');
const sceneLib = req(path.join(ROOT, 'lib/scene.js'));
const simLib = req(path.join(ROOT, 'lib/sim.js'));
const verifyLib = req(path.join(ROOT, 'lib/verify.js'));
const models = req(path.join(ROOT, 'lib/models/index.js'));
const planck = req(path.join(ROOT, 'vendor/planck.min.js'));

const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith('--')) args[a.slice(2)] = (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : true;
});

// 对拍判据（按"体积优先：临界量 0.1%"的策略设计）：
//   主判据 = verlet 的临界量对**解析解**的相对误差 ≤ 0.1%  ← 这是交付验收线
//   副判据 = 末态位置/速度与 planck 的一致性 ≤ 1% 量级      ← 抓"受力分支写错"这类粗错
//   诊断量 = 逐帧最大偏差（只打印，不判定）
// 为什么逐帧偏差不能当判据：planck 的接触求解有微小柔性，共速会比解析解晚一帧左右，
// 于是"共速前那一帧"的速度差可以达到 10%，但这只是亚帧级的时间错位，末态仍一致。
const TOL = {
  endPos: 0.01,     // 末态位置偏差 / 行程
  endVel: 0.01,     // 末态速度偏差 / 最大速率
  pos: 0.03,        // 逐帧位置偏差 / 行程（粗错护栏，放得比诊断宽）
  critical: 1e-3    // （保留）临界量相对误差参考线
};

/** 只在声明了 laws 的模型上跑（即已迁移到 Verlet 的模型） */
const targets = models.list.filter(m => {
  if (args.model) return m.id === args.model;
  const sc = models.scene(m.id, models.defaults(m), sceneLib);
  return !!sc.laws;
});

if (!targets.length) {
  console.log('没有已声明 laws 的模型可对拍。');
  process.exit(0);
}

/** 参数组合：默认 + 若干"临界点不落在步边界"的刁钻参数 */
function cases(m) {
  const def = models.defaults(m);
  const list = [{ tag: '默认', p: def }];
  if (m.id === 'plankPush') {
    list.push({ tag: 'μ₁=0.31（共速点不在步边界）', p: { ...def, mu1: 0.31 } });
    list.push({ tag: 'F=20（恰好临界，整体不滑动）', p: { ...def, force: 20 } });
    list.push({ tag: 'F=5（推不动）', p: { ...def, force: 5 } });
    list.push({ tag: 'F=45, tF=1.5（力更大时间更短）', p: { ...def, force: 45, tF: 1.5 } });
    list.push({ tag: 'μ₁=0.5, m=1, M=5（质量悬殊）', p: { ...def, mu1: 0.5, mass: 1, boardMass: 5 } });
    list.push({ tag: 'μ₂=0.28（地面摩擦接近能拖住）', p: { ...def, mu2: 0.28 } });
  }
  return list;
}

let failed = 0, checked = 0;
targets.forEach(m => {
  console.log('\n================  ' + m.id + '（' + m.title + '）  ================');
  cases(m).forEach(c => {
    const sceneP = models.scene(m.id, c.p, sceneLib);
    const sceneV = models.scene(m.id, c.p, sceneLib);
    let fp, fv;
    // verletOnly：planck 侧没有这种力（例如双星的相互引力），
    // 自检改为「全部对照项对解析解」，不再要求与 planck 逐帧一致。
    const noPlanck = !!sceneP.verletOnly;
    if (!noPlanck) {
      try { fp = simLib.createSim(planck, sceneP, { engine: 'planck' }).record(); }
      catch (e) { console.log('  ' + c.tag + '  planck 运行失败: ' + e.message); failed++; return; }
    } else {
      fp = simLib.createSim(null, sceneP, { engine: 'verlet' }).record();   // 占位，仅用于尺度统计
    }
    try { fv = simLib.createSim(null, sceneV, { engine: 'verlet' }).record(); }
    catch (e) { console.log('  ' + c.tag + '  verlet 运行失败: ' + e.message); failed++; return; }

    // 逐帧比对（帧数可能不同：verlet 按 meta.frames 输出，planck 相同）
    const n = Math.min(fp.frames.length, fv.frames.length);
    let maxPos = 0, maxVel = 0, maxForce = 0, worstFrame = -1, worstPos = 0;
    for (let i = 0; i < n; i++) {
      const a = fp.frames[i], b = fv.frames[i];
      Object.keys(a.bodies).forEach(id => {
        if (a.bodies[id].type !== 'dynamic') return;
        const A = a.bodies[id], B = b.bodies[id];
        if (!B) return;
        const dp = Math.hypot(A.x - B.x, A.y - B.y);
        const dv = Math.hypot(A.vx - B.vx, A.vy - B.vy);
        if (dp > maxPos) { maxPos = dp; worstFrame = i; }
        if (dv > maxVel) maxVel = dv;
        const df = Math.hypot(A.forces.total[0] - B.forces.total[0], A.forces.total[1] - B.forces.total[1]);
        if (df > maxForce) maxForce = df;
      });
    }

    // 临界量：相对滑动位移（只有"板-块"这类双体接触模型才有意义）
    const dynIds = Object.keys(fp.frames[0].bodies).filter(id => fp.frames[0].bodies[id].type === 'dynamic');
    const hasPair = !!(fp.frames[0].bodies.block && fp.frames[0].bodies.board);
    function maxRel(frames) {
      if (!hasPair) return null;
      const d0 = frames[0].bodies.block.x - frames[0].bodies.board.x;
      let mx = 0;
      frames.forEach(f => {
        const d = Math.abs((f.bodies.block.x - f.bodies.board.x) - d0);
        if (d > mx) mx = d;
      });
      return mx;
    }
    const relP = maxRel(fp.frames), relV = maxRel(fv.frames);
    // 主判据：模型自带的全部对照项（解析 vs 仿真）必须通过——这是通用判据，不依赖具体模型
    const tableV = verifyLib.run(m, c.p, fv.frames, sceneV) || [];
    const tableP = verifyLib.run(m, c.p, fp.frames, sceneP) || [];
    const badV = tableV.filter(it => it.pass === false);
    const badP = tableP.filter(it => it.pass === false);
    let worstV = 0, worstP = 0;
    tableV.forEach(it => { if (it.relError != null) worstV = Math.max(worstV, Math.abs(it.relError)); });
    tableP.forEach(it => { if (it.relError != null) worstP = Math.max(worstP, Math.abs(it.relError)); });

    // 末态一致性 + 运动尺度（用于把偏差归一化）。
    // 尺度取"整段行程/最大速率"，并给绝对底：静止类（推不动）与停止类（摩擦拖停）
    // 的尺度会趋近 0，没有绝对底就会除出无意义的百分比。
    // 末态取 95% 时刻而不是最后一帧：落地/碰撞那一帧两个引擎的处置方式天然不同
    // （谁把速度清零、谁还留着冲击速度），拿来互比没有意义，属于帧级实现细节。
    const nEnd = Math.max(1, Math.round((n - 1) * 0.95));
    let endPos = 0, endVel = 0, scalePos = 0, scaleVel = 0;
    dynIds.forEach(id => {
      const A0 = fp.frames[0].bodies[id];
      // 允许 ±5 帧的时间偏移：周期运动（圆周/振动）对微小周期差极敏感，
      // 同一时刻的位置可以差很多，但那是相位差不是物理错误。
      let bp = Infinity, bv = Infinity;
      for (let k = Math.max(0, nEnd - 5); k <= Math.min(n - 1, nEnd + 5); k++) {
        const A1 = fp.frames[nEnd].bodies[id], B1 = fv.frames[k].bodies[id];
        if (!A1 || !B1) continue;
        bp = Math.min(bp, Math.hypot(A1.x - B1.x, A1.y - B1.y));
        bv = Math.min(bv, Math.hypot(A1.vx - B1.vx, A1.vy - B1.vy));
      }
      if (isFinite(bp)) { endPos = Math.max(endPos, bp); endVel = Math.max(endVel, bv); }
      fp.frames.forEach(f => {
        const b = f.bodies[id];
        scalePos = Math.max(scalePos, Math.abs(b.x - A0.x), Math.abs(b.y - A0.y));
        scaleVel = Math.max(scaleVel, Math.hypot(b.vx, b.vy));
      });
    });
    const posTol = Math.max(0.05, TOL.endPos * scalePos);      // 位置：5 cm 或行程的 1%
    const velTol = Math.max(0.01, 0.02 * scaleVel);            // 速度：1 cm/s 或最大速率的 2%（周期运动允许相位差）
    const frameTol = Math.max(0.08, TOL.pos * scalePos);       // 逐帧粗错护栏

    const okCrit = badV.length === 0;                          // 主判据：全部对照项通过
    const okEnd = endPos <= posTol && endVel <= velTol;        // 副判据：末态一致
    const okPos = maxPos <= frameTol;                          // 粗错护栏
    const pass = okCrit && okEnd && okPos;
    checked++;
    if (!pass) failed++;
    console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  ' + c.tag + (noPlanck ? '  【仅自研引擎：planck 无此力，自检对解析解】' : ''));
    console.log('        对照项：verlet ' + (tableV.length - badV.length) + '/' + tableV.length +
      ' 通过（最大误差 ' + (worstV * 100).toFixed(3) + '%）' +
      (noPlanck ? '' : ' | planck ' + (tableP.length - badP.length) + '/' + tableP.length +
        ' 通过（最大误差 ' + (worstP * 100).toFixed(3) + '%）') +
      (badV.length ? '  ✗ ' + badV.map(x => x.label).join('、') : '  ✓'));
    if (relV != null) {
      console.log('        最大相对滑动 L_min：planck ' + relP.toFixed(4) + ' | verlet ' + relV.toFixed(4) +
        '（差 ' + (Math.abs(relV - relP) / Math.max(relP, 1e-3) * 100).toFixed(3) + '%）');
    }
    console.log('        末态一致性：位置 ' + endPos.toExponential(2) + ' m（限 ' + posTol.toFixed(3) +
      ' m）, 速度 ' + endVel.toExponential(2) + ' m/s（限 ' + velTol.toFixed(3) + ' m/s）  ' +
      (okEnd ? '✓' : '✗') + '   行程 ' + scalePos.toFixed(3) + ' m / 最大速率 ' + scaleVel.toFixed(2) + ' m/s');
    console.log('        【诊断】逐帧最大偏差：位置 ' + maxPos.toFixed(4) + ' m（第' + worstFrame +
      '帧）, 速度 ' + maxVel.toFixed(4) + ' m/s, 合力 ' + maxForce.toFixed(3) + ' N');
    if (!okEnd) console.log('        ✗ 末态偏差过大');
    if (!okPos) console.log('        ✗ 逐帧位置偏差过大（疑似受力分支写错）');
  });
});

console.log('\n' + '='.repeat(64));
console.log('对拍结果：' + checked + ' 组，' + (failed ? failed + ' 组未通过' : '全部通过') +
  '（主判据：verlet 全部对照项通过；副判据：末态与 planck 一致 ≤1% 量级）');
process.exit(failed ? 1 : 0);
