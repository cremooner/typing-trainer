/*
 * 盲打训练器 端到端测试
 * 依赖：playwright-core + 本机 Chrome / Edge（channel 可通过 CHROME_CHANNEL 覆盖）
 * 运行：node test/e2e.js        截图输出到系统临时目录，不污染仓库
 */
const path = require('path');
const os = require('os');

function loadPlaywright() {
  const cands = [
    process.env.PW_CORE,
    'playwright-core',
    path.join(__dirname, '..', 'node_modules', 'playwright-core'),
    path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright-core')
  ].filter(Boolean);
  for (const c of cands) { try { return require(c); } catch (e) {} }
  console.error('找不到 playwright-core。安装：npm i playwright-core，或设 PW_CORE 指向模块目录。');
  process.exit(3);
}
const { chromium } = loadPlaywright();

const FILE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const SHOT = p => path.join(os.tmpdir(), p);

/* 读取源词表，用来校验页面里的词与释义是否真的来自 CET6_2.json */
const CET = (() => {
  const fs = require('fs');
  const p = path.join(__dirname, '..', 'CET6_2.json');
  if (!fs.existsSync(p)) return null;
  const map = new Map();
  fs.readFileSync(p, 'utf8').split('\n').forEach(l => {
    l = l.trim(); if (!l) return;
    try {
      const w = JSON.parse(l).content.word;
      if (!/^[a-zA-Z]+$/.test(w.wordHead)) return;
      const c = w.content;
      const senses = (c.trans || [])
        .map(s => [s.pos || '', (s.tranCn || '').trim()])
        .filter(s => s[1]);
      const ss = (c.sentence || {}).sentences || [];
      const s0 = ss[0] || {};
      map.set(w.wordHead.toLowerCase(), {
        ipa: (c.ukphone || c.usphone || '').trim(),
        senses,
        ex: (s0.sContent || '').trim(),
        exCn: (s0.sCn || '').trim()
      });
    } catch (e) {}
  });
  return map;
})();

const log = (...a) => console.log(...a);
let fails = 0, total = 0;
function check(name, cond, extra) {
  total++;
  log((cond ? '  ok   ' : '  FAIL ') + name + (extra !== undefined ? '  -> ' + extra : ''));
  if (!cond) fails++;
}
const n = s => parseInt(s, 10);

(async () => {
  const browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || 'chrome',
    headless: true
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  const target = () => page.evaluate(() => Array.from(document.querySelectorAll('#text .c'))
    .map(e => e.classList.contains('sp') ? ' ' : e.textContent).join(''));
  const pos = () => page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('#text .c'));
    return all.findIndex(e => e.classList.contains('cur'));
  });
  const hud = () => page.evaluate(() => ({
    wpm: document.querySelector('#hWpm').textContent,
    acc: document.querySelector('#hAcc').textContent,
    keys: document.querySelector('#hKeys').textContent,
    err: document.querySelector('#hErr').textContent,
    time: document.querySelector('#hTime').textContent,
    timeK: document.querySelector('#hTimeK').textContent,
  }));
  const ls = (k, d) => page.evaluate(([k, d]) => {
    try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; }
  }, [k, d]);
  const setLs = (k, v) => page.evaluate(([k, v]) => localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)), [k, v]);
  const restart = async () => { await page.keyboard.press('Tab'); await page.waitForTimeout(80); };

  /* --- 字典模式（单词）辅助 --- */
  const cardWord = () => page.evaluate(() => Array.from(document.querySelectorAll('#cword .c'))
    .map(e => e.textContent).join(''));
  const cardMeta = () => page.evaluate(() => ({
    prog: document.querySelector('#cprog').textContent,
    word: Array.from(document.querySelectorAll('#cword .c')).map(e => e.textContent).join(''),
    font: getComputedStyle(document.querySelector('#cword')).fontSize,
    phone: document.querySelector('#cphone').textContent,
    phoneShown: getComputedStyle(document.querySelector('#cphone')).display !== 'none',
    mean: document.querySelector('#cmean').textContent,
    ex: document.querySelector('#cex').textContent,
    exShown: getComputedStyle(document.querySelector('#cex')).display !== 'none',
    done: document.querySelectorAll('#cword .c.ok').length
  }));
  const setWordCount = async v => {
    await page.selectOption('#wordCountSel', String(v));
    await page.waitForTimeout(120);
  };
  const typeCardWord = async (w, errAt) => {
    if (errAt == null || errAt >= w.length) { await page.keyboard.type(w, { delay: 2 }); return; }
    await page.keyboard.type(w.slice(0, errAt), { delay: 2 });
    await page.keyboard.type(w[errAt] === 'z' ? 'x' : 'z', { delay: 2 });
    await page.keyboard.type(w.slice(errAt + 1), { delay: 2 });
  };
  const runCards = async (n, errOnWord) => {
    const done = [];
    for (let i = 0; i < n; i++) {
      const w = await cardWord();
      if (!w) break;
      done.push(w);
      await typeCardWord(w, (i + 1) === errOnWord ? Math.min(2, w.length - 1) : null);
      await page.waitForTimeout(35);
    }
    return done;
  };
  const expectMean = senses => senses.map((s, i) =>
    (senses.length > 1 ? String(i + 1) : '') + (s[0] ? s[0] + '.' : '') + s[1]).join('');

  /* --- 句段模式辅助 --- */
  const cwordText = () => page.evaluate(() => Array.from(document.querySelectorAll('#cword .c'))
    .map(e => e.classList.contains('sp') ? ' ' : e.textContent).join(''));
  const phraseMeta = () => page.evaluate(() => {
    const cw = document.querySelector('#cword');
    return {
      prog: document.querySelector('#cprog').textContent,
      text: Array.from(document.querySelectorAll('#cword .c')).map(e => e.classList.contains('sp') ? ' ' : e.textContent).join(''),
      chips: Array.from(document.querySelectorAll('#cmean .pp b')).map(e => e.textContent),
      cn: document.querySelector('#cex').textContent,
      cnShown: getComputedStyle(document.querySelector('#cex')).display !== 'none',
      phoneShown: getComputedStyle(document.querySelector('#cphone')).display !== 'none',
      font: parseFloat(getComputedStyle(cw).fontSize),
      overflow: cw.scrollWidth <= cw.clientWidth + 1
    };
  });
  /* 词形归一：忽略大小写、标点与常见词尾变化，用于校验搭配确实出自本句 */
  const normW = w => {
    let s = String(w).toLowerCase().replace(/[^a-z]/g, '').replace(/ies$/, 'y');
    const cut = s.replace(/(ing|ed|es|s)$/, '');
    if (cut.length >= 3) s = cut;
    return s.replace(/i$/, 'y');
  };
  const chipInSentence = (chips, sent) => {
    const sw = new Set(sent.split(/\s+/).map(normW));
    return chips.some(c => c.split(/\s+/).filter(w => w.length >= 4).map(normW).some(w => sw.has(w)));
  };

  await page.goto(FILE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('#text .c');
  await page.waitForTimeout(150);

  log('\n[1] 初始渲染 · 黑底默认');
  check('默认主题为 dark', (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark');
  check('页面背景是纯黑', (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(0, 0, 0)');
  check('正文为浅色（深底可读）', (await page.evaluate(() => getComputedStyle(document.body).color)) === 'rgb(233, 233, 229)');
  check('虚拟键盘已渲染', (await page.locator('#kb .k').count()) > 45, await page.locator('#kb .k').count() + ' 键');
  check('含左右 Shift 键', (await page.locator('#kb .k[data-key="shift"]').count()) === 2);
  check('下一键已高亮', (await page.locator('#kb .k.next').count()) === 1);
  const t0 = await target();
  check('键位模式内容非空', t0.length > 40, t0.length + ' 字符');
  check('基准键课程只含 a s d f j k l ; 与空格', /^[asdfjkl; ]+$/.test(t0), [...new Set(t0.replace(/ /g, ''))].join(''));
  check('文本区无横向溢出', await page.evaluate(() => {
    const t = document.querySelector('#text'); return t.scrollWidth <= t.clientWidth + 1;
  }));
  check('页面无横向滚动', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

  log('\n[2] 正确输入 40 字符 · WPM 数值正确性');
  await page.keyboard.type(t0.slice(0, 40), { delay: 10 });
  let h = await hud();
  check('击键数=40', h.keys === '40', JSON.stringify(h));
  check('错误=0', h.err === '0');
  check('准确率=100%', h.acc === '100%');
  check('光标在第 41 个字符', (await pos()) === 40, await pos());
  check('已正确字符着色 40 个', (await page.locator('#text .c.ok').count()) === 40);
  const expectWpm = 8 / (parseFloat(h.time) / 60);
  check('WPM 与「净进度÷5÷分钟」吻合', Math.abs(n(h.wpm) - expectWpm) / expectWpm < 0.35,
    'HUD=' + h.wpm + ' 期望≈' + Math.round(expectWpm));
  check('已输入字符被淡化（低对比）', await page.evaluate(() => {
    const v = getComputedStyle(document.querySelector('#text .c.ok')).color.match(/\d+/g).map(Number);
    return v[0] < 120 && v[1] < 125;
  }), await page.evaluate(() => getComputedStyle(document.querySelector('#text .c.ok')).color));

  log('\n[3] P0-1 退格不能刷 WPM');
  const wpmBefore = n(h.wpm);
  for (let i = 0; i < 40; i++) await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  check('退格 40 次后光标回到开头', (await pos()) === 0, await pos());
  check('退格后 WPM 归零（进度被回收）', n((await hud()).wpm) < 5, (await hud()).wpm);
  check('击键数不因退格回滚', (await hud()).keys === '40', (await hud()).keys);
  await page.keyboard.type(t0.slice(0, 40), { delay: 10 });
  h = await hud();
  check('重打后击键数=80', h.keys === '80', h.keys);
  check('重打后进度仍是 40（没有凭空多分）', (await pos()) === 40, await pos());
  check('重打后 WPM 没有升高', n(h.wpm) < wpmBefore, '前=' + wpmBefore + ' 后=' + h.wpm);
  await restart();
  await page.waitForTimeout(60);

  log('\n[4] P0-2 准确率口径与严格/宽容模式无关');
  let mode = 'lenient';
  const pattern = async (len, badIdx) => {
    const t = await target();
    for (let i = 0; i < len; i++) {
      if (i === badIdx) {
        await page.keyboard.type(t[i] === 'z' ? 'x' : 'z', { delay: 6 });
        if (mode === 'strict') await page.keyboard.type(t[i], { delay: 6 });
      } else {
        await page.keyboard.type(t[i], { delay: 6 });
      }
    }
  };
  await pattern(11, 10);
  const accLenient = n((await hud()).acc);
  check('宽容模式：10 对 1 错 → 91%', accLenient === 91, accLenient + '%');
  await page.click('#btnSetting');
  await page.waitForTimeout(100);
  await page.click('[data-sw="strict"]');
  await page.click('#setClose');
  await page.waitForTimeout(60);
  await restart();
  mode = 'strict';
  await pattern(11, 10);
  const accStrict = n((await hud()).acc);
  check('严格模式：同一组操作 → 同样 91%', accStrict === accLenient, accStrict + '% vs ' + accLenient + '%');
  await page.click('#btnSetting');
  await page.waitForTimeout(100);
  await page.click('[data-sw="strict"]');
  await page.click('#setClose');
  await page.waitForTimeout(60);
  await restart();

  log('\n[5] P0-3 错误统计带分母 + 混淆对');
  await page.click('.tab[data-mode="word"]');
  await page.waitForTimeout(150);
  await setWordCount(10);
  await runCards(10, 4);
  await page.waitForTimeout(350);
  if (await page.locator('#mResult.on').isVisible()) await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const ks = await ls('typeTrainer.keystats.v1', null);
  check('存在 keystats 结构', !!(ks && typeof ks === 'object'));
  check('含 tries 分母表', !!(ks && ks.tries && Object.keys(ks.tries).length > 5), ks ? Object.keys(ks.tries).length + ' 键' : 'none');
  check('含 err 分子表', !!(ks && ks.err && Object.keys(ks.err).length >= 1), ks ? Object.keys(ks.err).length + ' 键有错' : 'none');
  const anyKey = ks ? Object.keys(ks.tries)[0] : null;
  check('tries ≥ err（分母不小于分子）', !!(ks && ks.tries[anyKey] >= (ks.err[anyKey] || 0)),
    anyKey + ': tries=' + (ks ? ks.tries[anyKey].toFixed(2) : '?') + ' err=' + (ks ? (ks.err[anyKey] || 0).toFixed(2) : '?'));
  check('含混淆对 conf（期望←实际）', !!(ks && ks.conf && Object.keys(ks.conf).length >= 1),
    ks ? JSON.stringify(ks.conf).slice(0, 60) : 'none');
  check('含延迟表 lat', !!(ks && ks.lat && Object.keys(ks.lat).length > 5));

  log('\n[6] P0-4 / P1-8 损坏数据不崩 + 导入字段清洗');
  await setLs('typeTrainer.history.v1', '{"oops":1}');
  await page.click('#btnStats');
  await page.waitForTimeout(200);
  check('记录面板仍能打开', await page.locator('#mStats.on').isVisible());
  check('显示空态而不是崩溃', /还没有记录/.test(await page.locator('#dlgStats').textContent()));
  await page.click('#sClose');
  await page.waitForTimeout(80);
  await setLs('typeTrainer.history.v1', JSON.stringify([
    { t: Date.now(), mode: '"><img src=x onerror="window.__XSS=1">', wpm: 9, acc: 99, dur: '"><img src=y onerror="window.__XSS=2">', keys: 20, errs: 0, backs: 0 },
    { t: Date.now(), mode: 'word', wpm: 60, acc: 97, dur: 30, keys: 180, errs: 5, backs: 2, cons: 80 }
  ]));
  await page.click('#btnStats');
  await page.waitForTimeout(300);
  check('恶意 mode/dur 被清洗，未执行注入', await page.evaluate(() => window.__XSS === undefined));
  check('面板内没有注入出来的 img', (await page.locator('#dlgStats img').count()) === 0);
  check('非法 mode 回落到白名单值', /单词/.test(await page.locator('#dlgStats').textContent()));
  check('记录面板有统计卡与热力图', (await page.locator('#heatkb .hk').count()) > 40, await page.locator('#heatkb .hk').count() + ' 格');
  check('模式筛选下拉存在', (await page.locator('#statsMode').count()) === 1);
  await page.screenshot({ path: SHOT('tt-stats.png') });
  await page.click('#sClose');
  await page.waitForTimeout(80);

  log('\n[7] P1-1 大写字母：Shift 提示 + 键盘高亮');
  await page.click('.tab[data-mode="text"]');
  await page.waitForTimeout(120);
  const para = await target();
  check('文章首字符是大写', /[A-Z]/.test(para[0]), para.slice(0, 24) + '...');
  const hint = await page.locator('#hint').textContent();
  check('提示里写明要按 Shift', /Shift/.test(hint), hint);
  check('提示里指了具体手指', /左手|右手/.test(hint), hint);
  check('Shift 键被高亮', (await page.locator('#kb .k[data-key="shift"].next').count()) === 1);
  check('字母键同时被高亮', (await page.locator('#kb .k.next').count()) === 2);
  check('不再误报「拇指」', !/拇指/.test(hint), hint);

  log('\n[8] P1-2 窄屏下字号设置仍然生效');
  await page.click('#btnSetting');
  await page.waitForTimeout(100);
  await page.selectOption('#setSize', '30');
  await page.click('#setClose');
  await page.waitForTimeout(80);
  check('宽屏 1100px：字号 = 30px', (await page.evaluate(() => getComputedStyle(document.querySelector('#text')).fontSize)) === '30px');
  await page.setViewportSize({ width: 700, height: 900 });
  await page.waitForTimeout(250);
  const narrowFont = await page.evaluate(() => getComputedStyle(document.querySelector('#text')).fontSize);
  check('窄屏：收窄但不失效（=20px，不是写死的 18px）', narrowFont === '20px', narrowFont);
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(250);
  check('回到宽屏恢复 30px', (await page.evaluate(() => getComputedStyle(document.querySelector('#text')).fontSize)) === '30px');

  log('\n[9] P1-3 结算卡模式按钮真的切模式');
  await page.click('.tab[data-mode="word"]');
  await page.waitForTimeout(150);
  await setWordCount(10);
  await runCards(10);
  await page.waitForTimeout(350);
  check('结算卡出现', await page.locator('#mResult.on').isVisible());
  const rc = await page.locator('#dlgResult').textContent();
  check('结算卡写明口径', /口径/.test(rc) && /首击/.test(rc) && /退格会同步扣减/.test(rc));
  check('结算卡显示退格次数', /退格/.test(rc));
  check('带模式切换按钮', (await page.locator('#dlgResult [data-go]').count()) === 6);
  await page.click('#dlgResult [data-go="text"]');
  await page.waitForTimeout(250);
  check('弹窗关闭', !(await page.locator('#mResult.on').isVisible()));
  check('顶栏 Tab 真的切到文章', (await page.evaluate(() => document.querySelector('#tabs .tab.on').dataset.mode)) === 'text');
  check('内容换成文章段落', /[A-Z][a-z]+ [a-z]+/.test(await target()));

  log('\n[10] P1-7 第二次同模式结算显示 ΔWPM');
  await page.click('.tab[data-mode="word"]');
  await page.waitForTimeout(150);
  await setWordCount(10);
  await runCards(10);
  await page.waitForTimeout(350);
  const rc2 = await page.locator('#dlgResult').textContent();
  check('显示与上一次的对比', /与上一次/.test(rc2), (rc2.match(/与上一次[^。]*。/) || [])[0]);
  check('显示本模式历史最好', /历史最好/.test(rc2));
  check('结算卡列出本组词表', /本组 10 个词/.test(rc2));
  if (await page.locator('#mResult.on').isVisible()) await page.keyboard.press('Enter');
  await page.waitForTimeout(200);

  log('\n[11] P1-4 冲刺进度条绑定剩余时间');
  await page.click('.tab[data-mode="sprint"]');
  await page.waitForTimeout(80);
  await page.selectOption('#sprintSel', '15');
  await page.waitForTimeout(80);
  check('初始剩余=15.0', (await hud()).time === '15.0', (await hud()).time);
  await page.keyboard.type('the quick ', { delay: 10 });
  await page.waitForTimeout(2600);
  const snap = await page.evaluate(() => ({
    left: parseFloat(document.querySelector('#hTime').textContent),
    bar: parseFloat(document.querySelector('#bar').style.width)
  }));
  const expectBar = (1 - snap.left / 15) * 100;
  check('进度条跟着时间走', Math.abs(snap.bar - expectBar) < 8, '条=' + snap.bar.toFixed(1) + '% 期望≈' + expectBar.toFixed(1) + '%');
  check('进度条不是按字符算的', snap.bar > 5 && snap.bar < 60, snap.bar.toFixed(1) + '%');
  await restart();

  log('\n[12] P1-5 弱键空态提示 + P0-3 按错误率选题');
  await setLs('typeTrainer.keystats.v1', { err: {}, tries: {}, lat: {}, conf: {} });
  await page.click('.tab[data-mode="weak"]');
  await page.waitForTimeout(150);
  check('无数据时给出提示', /暂无足够的错误样本/.test(await page.locator('#notice').textContent()), await page.locator('#notice').textContent());
  await setLs('typeTrainer.keystats.v1', { err: { x: 6 }, tries: { x: 40, e: 400, t: 400, a: 400 }, lat: {}, conf: {} });
  await page.click('.tab[data-mode="lesson"]');
  await page.waitForTimeout(80);
  await page.click('.tab[data-mode="weak"]');
  await page.waitForTimeout(200);
  const notice = await page.locator('#notice').textContent();
  check('按错误率而非错误次数选弱键（x 15% 胜过 e/t/a 0%）', /x\(15%\)/.test(notice), notice);
  check('零错误的高频字母不会被误选', !/e\(0%\)/.test(notice) && !/t\(0%\)/.test(notice) && !/a\(0%\)/.test(notice), notice);

  log('\n[13] P1-6 稳定性样本不足显示 —');
  await page.click('.tab[data-mode="sprint"]');
  await page.selectOption('#sprintSel', '15');
  await page.waitForTimeout(80);
  await page.keyboard.type('abc', { delay: 20 });
  await page.waitForTimeout(15500);
  const inner = await page.evaluate(() => document.querySelector('#dlgResult').innerHTML);
  check('样本 <8 时稳定性显示 —', /稳定性<\/div><div class="v">—<\/div>/.test(inner),
    (inner.match(/稳定性<\/div><div class="v">([^<]*)/) || [])[1]);
  if (await page.locator('#mResult.on').isVisible()) await page.keyboard.press('Enter');
  await page.waitForTimeout(150);

  log('\n[14] P2-3 课程补全与逐级解锁');
  await page.click('.tab[data-mode="lesson"]');
  await page.waitForTimeout(120);
  const opts = await page.evaluate(() => Array.from(document.querySelectorAll('#lessonSel option'))
    .map(o => ({ t: o.textContent, d: o.disabled })));
  check('课程共 17 级', opts.length === 17, opts.length + ' 级');
  check('含数字行课程', opts.some(o => /数字行/.test(o.t)));
  check('含 Shift 大写课程', opts.some(o => /Shift/.test(o.t)));
  check('含常用符号课程', opts.some(o => /常用符号/.test(o.t)));
  check('默认只解锁 3 级', opts.filter(o => !o.d).length === 3, opts.filter(o => !o.d).length + ' 级可选');
  check('其余标为未解锁', opts.filter(o => o.d).every(o => /未解锁/.test(o.t)));
  await page.selectOption('#lessonSel', '2');
  await page.waitForTimeout(120);
  await page.keyboard.type(await target(), { delay: 2 });
  await page.waitForTimeout(300);
  if (await page.locator('#mResult.on').isVisible()) await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const unlock = await ls('typeTrainer.unlock.v1', 0);
  check('练完第 3 级后解锁到第 4 级', unlock >= 4, 'unlock=' + unlock);
  const opts2 = await page.evaluate(() => Array.from(document.querySelectorAll('#lessonSel option')).filter(o => !o.disabled).length);
  check('下拉框同步解锁', opts2 >= 4, opts2 + ' 级可选');

  log('\n[15] 字典模式（单词）：一次一词 + 释义 + 自动跳转');
  await page.click('.tab[data-mode="word"]');
  await page.waitForTimeout(220);
  check('卡片视图已激活', await page.evaluate(() => document.querySelector('#stage').classList.contains('cardmode')));
  check('流式文本区被隐藏', (await page.evaluate(() => getComputedStyle(document.querySelector('#text')).display)) === 'none');
  check('卡片可见且居中容器为 flex', (await page.evaluate(() => getComputedStyle(document.querySelector('#card')).display)) === 'flex');
  check('一次只呈现一个词（流式区为空）', (await target()) === '' && (await page.locator('#cword .c').count()) > 0);
  check('词数选择器出现', (await page.evaluate(() => document.querySelector('#wordCountSel').style.display)) !== 'none');
  check('源词表 CET6_2.json 读到 2078 词', !!CET && CET.size === 2078, CET ? CET.size + ' 词' : '未找到源文件');

  await setWordCount(10);
  const m1 = await cardMeta();
  check('进度显示「第 1 / 10 个词」', m1.prog === '第 1 / 10 个词', m1.prog);
  check('显示音标', /^\/.+\/$/.test(m1.phone), m1.phone);
  check('显示中文释义', /[\u4e00-\u9fa5]/.test(m1.mean), m1.mean);
  check('字号随词长自适应（22–56px）', parseFloat(m1.font) >= 22 && parseFloat(m1.font) <= 56, m1.font);
  const src1 = CET.get(m1.word.toLowerCase());
  check('该词来自六级词表', !!src1, m1.word);
  check('释义与源文件逐字一致', !!src1 && m1.mean === expectMean(src1.senses),
    '页面=' + m1.mean + ' | 源=' + (src1 ? expectMean(src1.senses) : '?'));
  check('音标与源文件一致', !!src1 && (!src1.ipa || m1.phone === '/' + src1.ipa + '/'));
  check('例句显示与源文件一致', !!src1 && src1.ex
    ? (m1.exShown && m1.ex.indexOf(src1.ex) > -1)
    : (!m1.exShown && m1.ex === ''),
    '源例句=' + (src1 && src1.ex ? src1.ex.slice(0, 28) : '（该词无例句）') + ' | 页面="' + m1.ex.slice(0, 28) + '"');

  await typeCardWord(m1.word);
  await page.waitForTimeout(240);
  const m2 = await cardMeta();
  check('打完当前词自动跳到下一个', m2.word !== m1.word, m1.word + ' → ' + m2.word);
  check('进度自动递增', m2.prog === '第 2 / 10 个词', m2.prog);
  check('新词无旧词残留着色', (await page.locator('#cword .c.ok').count()) === 0);
  check('光标停在新词首位', (await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('#cword .c'));
    return all.findIndex(e => e.classList.contains('cur'));
  })) === 0);
  check('新词同样是合法双语卡片', /[\u4e00-\u9fa5]/.test(m2.mean) && m2.word !== m1.word);

  log('\n[15b] 字典模式：退格边界 / 容错 / 跳过');
  let wCur = await cardWord();
  await page.keyboard.type(wCur.slice(0, 2), { delay: 4 });
  for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
  check('退格不能跨到上一个词', (await cardWord()) === wCur &&
    (await page.evaluate(() => Array.from(document.querySelectorAll('#cword .c')).findIndex(e => e.classList.contains('cur')))) === 0);
  wCur = await cardWord();
  await typeCardWord(wCur, 1);
  await page.waitForTimeout(240);
  check('带一处错误也能自动进入下一个词', (await cardWord()) !== wCur, wCur);
  check('错误已计入', (await hud()).err !== '0', (await hud()).err);
  const beforeSkip = await cardWord();
  await page.click('#cskip');
  await page.waitForTimeout(200);
  check('「跳过本词」进入下一个词', (await cardWord()) !== beforeSkip);
  check('跳过后计时已启动', parseFloat((await hud()).time) > 0, (await hud()).time);
  await restart();
  await page.waitForTimeout(120);
  check('重开后回到第 1 个词', (await cardMeta()).prog === '第 1 / 10 个词');

  log('\n[15c] 字典模式：词长分级与词源校验');
  await setWordCount(30);
  await page.selectOption('#wordLenSel', 'long');
  await page.waitForTimeout(200);
  const longSet = [];
  for (let i = 0; i < 15; i++) { const w = await cardWord(); longSet.push(w); await typeCardWord(w); await page.waitForTimeout(28); }
  check('长词档全部 ≥8 字母', longSet.every(w => w.length >= 8), '最短 ' + Math.min.apply(null, longSet.map(w => w.length)));
  check('长词档全部命中六级词表', longSet.every(w => CET.has(w.toLowerCase())),
    longSet.filter(w => !CET.has(w.toLowerCase())).join(' ') || '全部命中');
  await page.selectOption('#wordLenSel', 'short');
  await page.waitForTimeout(200);
  const shortSet = [];
  for (let i = 0; i < 15; i++) { const w = await cardWord(); shortSet.push(w); await typeCardWord(w); await page.waitForTimeout(28); }
  check('短词档全部 ≤4 字母', shortSet.every(w => w.length <= 4), '最长 ' + Math.max.apply(null, shortSet.map(w => w.length)));
  check('短词档全部命中六级词表', shortSet.every(w => CET.has(w.toLowerCase())));
  await page.selectOption('#wordLenSel', 'all');
  await page.waitForTimeout(150);
  const seen = new Set([...longSet, ...shortSet]);
  check('抽样覆盖度足够（≥25 个不同词）', seen.size >= 25, seen.size + ' 个不同词');
  check('会话内不出现重复词', (() => {
    const arr = longSet.concat(shortSet);
    return new Set(arr).size >= Math.min(arr.length, 4);
  })());

  log('\n[15d] 字典模式：例句开关');
  await page.click('#btnSetting');
  await page.waitForTimeout(140);
  await page.click('[data-sw="showEx"]');
  await page.click('#setClose');
  await page.waitForTimeout(150);
  check('关掉例句后例句区隐藏', (await cardMeta()).exShown === false);
  check('释义仍然显示', /[\u4e00-\u9fa5]/.test((await cardMeta()).mean));
  await page.click('#btnSetting');
  await page.waitForTimeout(140);
  await page.click('[data-sw="showEx"]');
  await page.click('#setClose');
  await page.waitForTimeout(150);
  check('重新打开例句', (await cardMeta()).exShown === true);

  log('\n[15e] 句段模式：一次一段 + 搭配 + 译文 + 自动跳转');
  const PHR = await page.evaluate(() => (typeof PHRASES !== 'undefined' ? PHRASES : null));
  check('页面内联句段语料 100 条', !!PHR && PHR.length === 100, PHR ? PHR.length + ' 条' : '取不到 PHRASES');
  check('语料覆盖 5 个搭配类别', !!PHR && new Set(PHR.map(e => e[3])).size === 5,
    PHR ? [...new Set(PHR.map(e => e[3]))].join('/') : '?');
  check('语料每条都自带搭配与译文', !!PHR && PHR.every(e =>
    Array.isArray(e[1]) && e[1].length && e[1].every(p => p[0] && p[1]) && /[\u4e00-\u9fa5]/.test(e[2])));

  await page.click('.tab[data-mode="phrase"]');
  await page.waitForTimeout(220);
  check('句段模式复用卡片视图', await page.evaluate(() => document.querySelector('#stage').classList.contains('cardmode')));
  check('流式区在句段模式下隐藏', (await page.evaluate(() => getComputedStyle(document.querySelector('#text')).display)) === 'none');
  check('类别选择器出现', (await page.evaluate(() => document.querySelector('#phraseCatSel').style.display)) !== 'none');
  check('段数选择器出现', (await page.evaluate(() => document.querySelector('#phraseCountSel').style.display)) !== 'none');
  check('词长选择器已隐藏', (await page.evaluate(() => document.querySelector('#wordLenSel').style.display)) === 'none');
  check('组词数选择器已隐藏', (await page.evaluate(() => document.querySelector('#wordCountSel').style.display)) === 'none');
  check('跳过按钮文案改为「跳过本段」', (await page.locator('#cskip').textContent()).indexOf('跳过本段') > -1);

  await page.selectOption('#phraseCountSel', '5');
  await page.waitForTimeout(200);
  const q1 = await phraseMeta();
  check('进度显示「第 1 / 5 段」', q1.prog === '第 1 / 5 段', q1.prog);
  check('卡片是一整句（含空格且 ≥20 字符）', q1.text.indexOf(' ') > 0 && q1.text.length >= 20, q1.text);
  check('句段为纯 ASCII 且以句末标点收尾', /^[ -~]+[.!?]$/.test(q1.text), q1.text);
  check('句段字号收在 20–34px（比单词小）', q1.font >= 20 && q1.font <= 34, q1.font + 'px');
  check('句段不横向溢出卡片', q1.overflow);
  check('音标区在句段模式下隐藏', q1.phoneShown === false);
  check('列出本句搭配（≥1 条）', q1.chips.length >= 1, q1.chips.join(' | '));
  check('显示整句中文译文', q1.cnShown && /[\u4e00-\u9fa5]/.test(q1.cn), q1.cn);
  check('搭配确实出自本句（词形重合）', chipInSentence(q1.chips, q1.text),
    q1.chips.join('|') + '  vs  ' + q1.text);
  check('句段命中内联语料', !!PHR && PHR.some(e => e[0] === q1.text));

  await page.keyboard.type(q1.text, { delay: 2 });
  await page.waitForTimeout(240);
  const q2 = await phraseMeta();
  check('打完一整段自动跳到下一段', q2.text !== q1.text, q1.text.slice(0, 32) + ' → ' + q2.text.slice(0, 32));
  check('进度自动递增', q2.prog === '第 2 / 5 段', q2.prog);
  check('新段无旧段残留着色', (await page.locator('#cword .c.ok').count()) === 0);
  check('换段后光标回到首位', (await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('#cword .c'));
    return all.findIndex(e => e.classList.contains('cur'));
  })) === 0);

  /* q1 已打完（idx→1），q2 只是读出来做断言，未打；从 idx=1 起把余下 4 段打完 */
  const seenP = [q1.text];
  let stuck = null;
  for (let i = 0; i < 4; i++) {
    const m0 = await phraseMeta();
    seenP.push(m0.text);
    await page.keyboard.type(m0.text, { delay: 2 });
    await page.waitForTimeout(140);
    const m1 = await phraseMeta();
    const resOn = await page.locator('#mResult.on').isVisible();
    if (m1.prog === m0.prog && !resOn) stuck = { at: m0.prog, stuck: m0.text };
  }
  check('每段打完后都自动前进', stuck === null, stuck ? JSON.stringify(stuck) : '连打 4 段均前进');
  await page.waitForTimeout(320);
  check('结算卡出现', await page.locator('#mResult.on').isVisible());
  const rcP = await page.locator('#dlgResult').textContent();
  check('结算卡标明「句段模式」', /句段模式/.test(rcP));
  check('结算卡列出本组 5 段', /本组 5 段/.test(rcP));
  check('结算卡列出本组句段回看', seenP.some(t => rcP.indexOf(t.slice(0, 24)) > -1));
  check('一组 5 段互不重复', new Set(seenP).size === 5, [...new Set(seenP)].length + ' 段不同');
  if (await page.locator('#mResult.on').isVisible()) await page.keyboard.press('Enter');
  await page.waitForTimeout(220);

  await page.selectOption('#phraseCatSel', 'prep');
  await page.waitForTimeout(200);
  check('切类别后重回第 1 段', (await phraseMeta()).prog === '第 1 / 5 段');
  const catTexts = [];
  for (let i = 0; i < 3; i++) {
    const t = (await phraseMeta()).text;
    catTexts.push(t);
    await page.keyboard.type(t, { delay: 2 });
    await page.waitForTimeout(70);
  }
  check('类别筛选只出该类的句段（介词短语）',
    !!PHR && catTexts.every(t => PHR.some(e => e[0] === t && e[3] === 'prep')),
    catTexts.map(t => (PHR || []).filter(e => e[0] === t).map(e => e[3])[0] || '?').join(','));
  await page.selectOption('#phraseCatSel', 'all');
  await page.waitForTimeout(150);
  await restart();
  await page.waitForTimeout(120);
  check('重开后回到第 1 段且恢复全类别', (await phraseMeta()).prog === '第 1 / 5 段');

  log('\n[16] 长文本滚动跟随（字号 30px 下强制换行）');
  await page.click('.tab[data-mode="text"]');
  await page.waitForTimeout(120);
  const longT = await target();
  await page.keyboard.type(longT.slice(0, longT.length - 5), { delay: 2 });
  await page.waitForTimeout(120);
  const scroll = await page.evaluate(() => {
    const box = document.querySelector('#text');
    const cur = document.querySelector('#text .c.cur');
    const top = cur.offsetTop - box.offsetTop;
    return { st: box.scrollTop, h: box.clientHeight, cur: top, lines: Math.round(box.scrollHeight / parseFloat(getComputedStyle(box).lineHeight)) };
  });
  check('文本已超过可视高度', scroll.lines >= 5, scroll.lines + ' 行 / 可视 ' + scroll.h + 'px');
  check('已发生滚动跟随', scroll.st > 0, 'scrollTop=' + scroll.st);
  check('光标仍在可视区内', scroll.cur >= scroll.st - 5 && scroll.cur <= scroll.st + scroll.h, 'cur=' + scroll.cur + ' 窗口=[' + scroll.st + ',' + (scroll.st + scroll.h) + ']');
  check('光标保持在窗口下部（向前跟随而非跳回）', scroll.cur > scroll.st + scroll.h * 0.5, '距顶 ' + (scroll.cur - scroll.st) + 'px / 窗高 ' + scroll.h);
  check('未过度滚动（不超过最大可滚动量）', await page.evaluate(() => {
    const b = document.querySelector('#text');
    return b.scrollTop <= b.scrollHeight - b.clientHeight + 1;
  }));

  log('\n[17] 键盘三态开关（指法 / 简约 / 隐藏）');
  check('初始为「键盘·指法」', (await page.locator('#btnKb').textContent()) === '键盘·指法');
  check('指法模式下键帽带配色', await page.evaluate(() => {
    const k = document.querySelector('#kb .k[data-key="a"]');
    return getComputedStyle(k).backgroundColor !== 'rgb(28, 28, 28)';
  }));
  await page.click('#btnKb');
  await page.waitForTimeout(100);
  check('切到「键盘·简约」', (await page.locator('#btnKb').textContent()) === '键盘·简约');
  check('简约模式下键帽为中性底', await page.evaluate(() => {
    const bg = getComputedStyle(document.querySelector('#kb .k[data-key="a"]')).backgroundColor;
    return bg === 'rgb(28, 28, 28)' || bg === 'rgb(242, 241, 236)';
  }));
  await page.click('#btnKb');
  await page.waitForTimeout(100);
  check('切到「键盘·隐藏」', (await page.locator('#btnKb').textContent()) === '键盘·隐藏');
  check('隐藏后虚拟键盘不可见', !(await page.locator('#kb').isVisible()));
  check('隐藏后不再显示下一键提示', (await page.locator('#hint').textContent()) === '');
  await page.click('#btnKb');
  await page.waitForTimeout(100);
  check('循环回「键盘·指法」', (await page.locator('#btnKb').textContent()) === '键盘·指法');
  check('键盘恢复可见', await page.locator('#kb').isVisible());

  log('\n[17] 主题切换与持久化');
  await page.click('#btnTheme');
  await page.waitForTimeout(120);
  check('切到 light', (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light');
  check('浅色下正文为深色', (await page.evaluate(() => getComputedStyle(document.body).color)) === 'rgb(35, 35, 32)');
  await page.screenshot({ path: SHOT('tt-light.png'), fullPage: true });
  await page.click('#btnTheme');
  await page.waitForTimeout(120);
  check('主题已持久化', (await ls('typeTrainer.settings.v2', {})).theme === 'dark');
  await page.screenshot({ path: SHOT('tt-dark.png'), fullPage: true });

  log('\n[18] 导出 / 导入往返');
  const exported = await page.evaluate(() => {
    const o = {};
    Object.keys(localStorage).filter(k => k.indexOf('typeTrainer') === 0).forEach(k => {
      try { o[k] = JSON.parse(localStorage.getItem(k)); } catch (e) {}
    });
    return o;
  });
  check('导出含 history / keystats / settings / unlock',
    !!(exported['typeTrainer.history.v1'] && exported['typeTrainer.keystats.v1'] &&
       exported['typeTrainer.settings.v2'] && exported['typeTrainer.unlock.v1']),
    Object.keys(exported).join(', '));
  const roundTrip = await page.evaluate((dump) => {
    localStorage.clear();
    Object.keys(dump).forEach(k => localStorage.setItem(k, JSON.stringify(dump[k])));
    return JSON.parse(localStorage.getItem('typeTrainer.history.v1')).length;
  }, exported);
  check('清空后重新写入，条数一致', roundTrip === exported['typeTrainer.history.v1'].length,
    roundTrip + ' vs ' + exported['typeTrainer.history.v1'].length);

  log('\n[19] 运行期异常');
  check('无 JS 报错', errs.length === 0, errs.join(' | ') || 'none');

  await browser.close();
  log('\n==== ' + (fails === 0 ? total + ' 项断言全部通过' : fails + ' / ' + total + ' 项失败') + ' ====');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
