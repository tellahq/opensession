#!/usr/bin/env bun
/**
 * css-rulekill — "does this legacy rule still change anything?", answered by
 * deleting it from the LIVE stylesheet and re-rendering the real page.
 *
 * This is the third leg of the migration toolkit, and it exists because the
 * other two are blind to the same thing:
 *
 *   · scripts/css-audit.ts asks whether a class NAME still appears in the
 *     source. It cannot see a rule whose name survives on the markup as a
 *     hook — base.css names it, a `closest()` call reaches it, another class
 *     module writes `[.that-class_&]` — while every one of its declarations
 *     now loses to a utility on the same element. Live name, dead body.
 *   · scripts/css-ab.ts compares two BUILDS. To use it on a deletion you have
 *     to land the deletion first, which is the wrong order.
 *
 * So: snapshot every element under <body> (all computed longhands, plus
 * ::before/::after and the non-enumerable corner-*-shape set, hashed page-side
 * so only a fingerprint per element crosses the wire), delete the target rules
 * from whichever sheet holds them, snapshot again, then put every rule back at
 * its original index — index, because order is cascade.
 *
 * All the candidates are deleted TOGETHER: if the page is identical with the
 * whole set gone, every one of them is dead, which is one measurement instead
 * of forty. `--each` bisects when the answer isn't zero.
 *
 * Three things keep a "0 changes" honest, and none of them is optional:
 *
 *   1. `--control <selector>` also deletes a rule that provably IS live, and
 *      the run aborts if that one reports no difference. Without it, "no
 *      difference" is equally consistent with a probe that sees nothing at
 *      all — which is exactly what a broken run looks like.
 *   2. Every target's MATCH COUNT on the page is printed first. A rule that
 *      matches nothing scored 0 for a reason that has nothing to do with
 *      whether it is dead; put the page into the state that renders it with
 *      `--add` / `--click` / `--hover` / `--remove`, or measure it elsewhere.
 *   3. The noise floor is two identical snapshots, and anything still moving
 *      after the rules are RESTORED is subtracted as page churn. A live
 *      elapsed timer otherwise reads as a rule doing something.
 *
 * Usage:
 *   bun scripts/css-rulekill.ts --targets <file> --route /archived \
 *       --control '.workspace-shell' --freeze [--vw 390] [--theme light]
 *       [--each] [--add=body=chrome-collapsed] [--click='.trigger']
 *       [--hover='.row > button'] [--remove='.extra-tab']
 *
 * <file> is one selector per line, `#` for comments, written exactly as the
 * stylesheet spells them (whitespace and `:not( … )` padding are normalized).
 *
 * Starts a private, bounded headful Chrome on a virtual display. CDP_PORT may
 * explicitly select an externally managed browser when needed.
 */
import { readFileSync } from "node:fs";
import {
  acquireCdpBrowser,
  cdpSender,
  closeCdpTarget,
  releaseCdpBrowser,
} from "./lib/cdp-browser";
import { localAutomationToken } from "./lib/local-auth";

const APP = process.env.OPENSESSION_URL ?? "http://127.0.0.1:3850";

const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const ROUTE = flag("route", "/")!;
const VW = Number(flag("vw", "1440"));
const VH = Number(flag("vh", "1000"));
const THEME = flag("theme", "dark")!;
const CONTROL = flag("control");
const EACH = argv.includes("--each");
const SETTLE = Number(flag("settle", "4000"));
/** Animated elements resolve differently between two identical snapshots (a
 *  pulse dot's opacity, a spinner's transform), which reads as a rule having an
 *  effect. Freeze them so the floor is a true zero. */
const FREEZE = argv.includes("--freeze");
/** Several rules are keyed off a state the page is not in at rest — a body
 *  class the scroll handler sets, the collapsed-sidebar flag, the phone info
 *  page that only exists once its title is tapped. Measuring them without
 *  putting the page INTO that state scores 0 for a reason that has nothing to
 *  do with the rule. `--add 'body=chrome-collapsed'` / `--click '<sel>'` put it
 *  there first; the match-count report is what proves it worked. */
const ADDS = argv.filter((a) => a.startsWith("--add=")).map((a) => a.slice(6));
const CLICKS = argv
  .filter((a) => a.startsWith("--click="))
  .map((a) => a.slice(8));
/** A `:hover` rule scores 0 on a page nothing is being pointed at, which is
 *  not the same as being dead. Forced through CDP, so hover styling is part of
 *  the same measurement. */
const HOVERS = argv
  .filter((a) => a.startsWith("--hover="))
  .map((a) => a.slice(8));
/** Remove nodes to reach a state the live app isn't in — the strip's "lone
 *  session" hide only matches a strip with one tab and no view tab. */
const REMOVES = argv
  .filter((a) => a.startsWith("--remove="))
  .map((a) => a.slice(9));
/** Selectors to kill, one per line, in a file (so quoting never bites). */
const TARGETS: string[] = readFileSync(flag("targets")!, "utf8")
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith("#"));

const lease = await acquireCdpBrowser();
const PORT = lease.port;
let target: any;
let ws!: WebSocket;
try {
  target = await fetch(`http://127.0.0.1:${PORT}/json/new?url=about:blank`, {
    method: "PUT",
  }).then((r) => r.json());
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  // The whole reply, not just `.result`: `evaluate` below reads through
  // `r.result.result.value`.
  const send = cdpSender(ws, "envelope");
  const evaluate = async (expression: string) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r?.result?.exceptionDetails)
      throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 1500));
    return r?.result?.result?.value;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const token = localAutomationToken();
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  if (token)
    await send("Network.setCookie", {
      name: "opensession_auth",
      value: token,
      url: APP,
      path: "/",
    });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem('opensession-theme', ${JSON.stringify(THEME)}); } catch (e) {}`,
  });
  // Metrics AFTER navigate is the documented ordering trap; set them, navigate,
  // then set them again so the app lays out at the width we claim to measure.
  await send("Emulation.setDeviceMetricsOverride", {
    width: VW,
    height: VH,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: VW,
    screenHeight: VH,
  });
  await send("Page.navigate", { url: APP + ROUTE });
  await sleep(SETTLE);
  await send("Emulation.setDeviceMetricsOverride", {
    width: VW,
    height: VH,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: VW,
    screenHeight: VH,
  });
  if (FREEZE)
    await evaluate(`(() => { const s = document.createElement('style');
	  s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;}';
	  document.head.appendChild(s); })()`);
  for (const c of CLICKS) {
    const hit =
      await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(c)});
	  if (!el) return 'NOT FOUND'; el.click(); return 'clicked'; })()`);
    console.log(`click ${c}: ${hit}`);
    await sleep(1200);
  }
  for (const a of ADDS) {
    const [sel, cls] = a.split("=");
    const r =
      await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
	  if (!el) return 'NOT FOUND'; el.classList.add(${JSON.stringify(cls)}); return el.className.slice(0, 60); })()`);
    console.log(`add ${cls} to ${sel}: ${r}`);
  }
  for (const rm of REMOVES) {
    const n =
      await evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(rm)})];
	  els.forEach(e => e.remove()); return els.length; })()`);
    console.log(`removed ${rm}: ${n} node(s)`);
    await sleep(400);
  }
  for (const h of HOVERS) {
    await send("DOM.enable");
    await send("CSS.enable");
    const { root } = await send("DOM.getDocument", { depth: 1 }).then(
      (r: any) => r.result,
    );
    const { nodeIds } = await send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: h,
    }).then((r: any) => r.result);
    for (const nodeId of nodeIds ?? [])
      await send("CSS.forcePseudoState", {
        nodeId,
        forcedPseudoClasses: ["hover"],
      }).catch(() => {});
    console.log(`forced :hover on ${h}: ${(nodeIds ?? []).length} node(s)`);
    await sleep(500);
  }
  await send("Page.bringToFront");
  await sleep(1200);

  /* Page-side helpers, installed once. */
  await evaluate(`window.__rk = (() => {
  const EXTRA = ['corner-shape','corner-top-left-shape','corner-top-right-shape','corner-bottom-left-shape','corner-bottom-right-shape'];
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h; };
  const bag = (el, pseudo) => {
    const cs = getComputedStyle(el, pseudo);
    if (pseudo && (!cs.content || cs.content === 'none')) return '';
    let s = '';
    for (let i = 0; i < cs.length; i++) s += cs[i] + ':' + cs.getPropertyValue(cs[i]) + ';';
    for (const p of EXTRA) s += p + ':' + cs.getPropertyValue(p) + ';';
    return s;
  };
  const walk = () => {
    const out = [];
    const seen = new Map();
    const rec = (el, path) => {
      const r = el.getBoundingClientRect();
      out.push([path, hash(bag(el, null) + '|' + bag(el, '::before') + '|' + bag(el, '::after')),
                Math.round(r.x * 100) / 100, Math.round(r.y * 100) / 100,
                Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100,
                el.tagName + '.' + (typeof el.className === 'string' ? el.className : '')]);
      let i = 0;
      for (const c of el.children) rec(c, path + '/' + (i++) + ':' + c.tagName);
    };
    rec(document.body, 'body');
    return out;
  };
  /* Every rule in every same-origin sheet, flattened through @media/@supports,
     each remembered with its owning parent + index so it can go back exactly
     where it was — re-inserting at the end would silently reorder the cascade. */
  const index = () => {
    const found = [];
    const visit = (list, parent) => {
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.cssRules && r.cssRules.length && !r.selectorText) { visit(r.cssRules, r); continue; }
        if (r.selectorText) found.push({ parent, i, sel: r.selectorText, text: r.cssText });
      }
    };
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
      if (!sheet.href || !/legacy|global|App-/.test(sheet.href)) { if (!sheet.href) continue; }
      visit(rules, sheet);
    }
    return found;
  };
  return { walk, index, killed: [] };
})()`);

  /* Both canaries assert a VALUE, not truthiness. The previous global-sheet probe
   read `.terminal`'s font-family and only checked it was non-empty — which an
   unstyled div satisfies with the inherited body font, so it went on passing
   after that class was migrated away and stopped testing anything. Any legacy
   class is a wasting asset here by design; `.app` is base.css's, and base.css
   is concatenated with legacy.css into the one global sheet, so it answers the
   question that actually matters (is the hand-written sheet being served) and
   does not expire when the last legacy rule goes. */
  const sanity = await evaluate(`(() => {
  const d = document.createElement('div'); d.className = 'p-3'; document.body.appendChild(d);
  const tw = getComputedStyle(d).padding; d.className = 'app';
  const global = getComputedStyle(d).flexDirection; d.remove();
  return { tw, global, theme: document.documentElement.dataset.theme,
           path: location.pathname, w: innerWidth, els: document.querySelectorAll('*').length };
})()`);
  console.log(
    `route=${sanity.path} w=${sanity.w} theme=${sanity.theme} els=${sanity.els}`,
  );
  console.log(
    `sanity: tailwind p-3=${sanity.tw} (want 12px); global .app flex-direction=${sanity.global} (want column)`,
  );
  if (sanity.tw !== "12px" || sanity.global !== "column") {
    throw new Error(
      "STOP: both sheets must be live or every verdict is 'identical' for the wrong reason",
    );
  }

  const snapshot = async (): Promise<any[]> => {
    const n = await evaluate(`(window.__rkSnap = window.__rk.walk()).length`);
    const CH = 4000;
    const out: any[] = [];
    for (let i = 0; i < n; i += CH)
      out.push(...(await evaluate(`window.__rkSnap.slice(${i}, ${i + CH})`)));
    return out;
  };

  const diffSnaps = (a: any[], b: any[]) => {
    const ma = new Map(a.map((e) => [e[0], e]));
    const mb = new Map(b.map((e) => [e[0], e]));
    const changed: string[] = [];
    for (const [p, ea] of ma) {
      const eb = mb.get(p);
      if (!eb) {
        changed.push(`GONE ${p}`);
        continue;
      }
      if (ea[1] !== eb[1]) changed.push(`STYLE ${p} ${ea[6]?.slice(0, 70)}`);
      else if (
        ea[2] !== eb[2] ||
        ea[3] !== eb[3] ||
        ea[4] !== eb[4] ||
        ea[5] !== eb[5]
      )
        changed.push(
          `RECT ${p} ${ea[2]},${ea[3]} ${ea[4]}x${ea[5]} => ${eb[2]},${eb[3]} ${eb[4]}x${eb[5]}  ${ea[6]?.slice(0, 60)}`,
        );
    }
    for (const p of mb.keys()) if (!ma.has(p)) changed.push(`NEW ${p}`);
    return changed;
  };

  const kill = (sels: string[]) =>
    evaluate(`(() => {
    const norm = (s) => s.replace(/\\s+/g, ' ').replace(/\\(\\s+/g, '(').replace(/\\s+\\)/g, ')').trim();
    const want = new Set(${JSON.stringify(sels)}.map(norm));
    const all = window.__rk.index();
    const hits = all.filter(r => want.has(norm(r.sel)));
    // Delete from the highest index down, so earlier indices stay valid.
    const byParent = new Map();
    for (const h of hits) { if (!byParent.has(h.parent)) byParent.set(h.parent, []); byParent.get(h.parent).push(h); }
    const killed = [];
    for (const [parent, list] of byParent) {
      list.sort((a, b) => b.i - a.i);
      for (const h of list) { parent.deleteRule(h.i); killed.push({ parent, i: h.i, text: h.text, sel: h.sel, href: (h.parent.href || (h.parent.parentStyleSheet && h.parent.parentStyleSheet.href) || '?') }); }
    }
    window.__rk.killed = killed;
    const missing = [...want].filter(w => !hits.some(h => norm(h.sel) === w));
    const sheets = {};
    for (const k of killed) { const n = String(k.href).split('/').pop(); sheets[n] = (sheets[n] || 0) + 1; }
    return { killed: killed.length, missing, sheets };
  })()`);

  const restore = () =>
    evaluate(`(() => {
    const k = window.__rk.killed.slice().sort((a, b) => a.i - b.i);
    for (const r of k) r.parent.insertRule(r.text, r.i);
    window.__rk.killed = [];
    return k.length;
  })()`);

  /** Paths that differ between two identical snapshots — subtracted from every
   *  verdict, so an animated dot can never be mistaken for a live rule. */
  let FLOOR = new Set<string>();

  /* How many elements each target actually matches on THIS page. A rule that
   matches nothing here scores 0 changes for a reason that has nothing to do
   with whether it is dead — so a verdict is only worth reading next to this. */
  const matches = await evaluate(`(() => {
  const out = {};
  for (const s of ${JSON.stringify(TARGETS)}) {
    try { out[s] = document.querySelectorAll(s).length; } catch (e) { out[s] = 'BAD SELECTOR'; }
  }
  return out;
})()`);
  const unmatched = Object.entries(matches)
    .filter(([, n]) => n === 0)
    .map(([s]) => s);
  console.log("\nmatched on this page:");
  for (const [s, n] of Object.entries(matches))
    console.log(`   ${String(n).padStart(4)}  ${s}`);
  if (unmatched.length)
    console.log(
      `   ^ ${unmatched.length} selector(s) match NOTHING here — their verdict below is vacuous, measure them on a page that renders them`,
    );

  console.log(`\ntargets: ${TARGETS.length} selector(s)`);
  const before = await snapshot();
  console.log(`baseline: ${before.length} elements`);

  /* Noise floor: two snapshots with nothing changed. A live clock or a running
   animation would otherwise read as a rule doing something. */
  await sleep(400);
  const before2 = await snapshot();
  const floor = diffSnaps(before, before2);
  console.log(
    `noise floor (same page, nothing deleted): ${floor.length} ${floor.length ? "(excluded from every verdict below)" : "OK"}`,
  );
  for (const c of floor.slice(0, 6)) console.log(`   ${c}`);

  FLOOR = new Set(floor.map((c) => c.split(" ")[1]));

  /* Control: a rule that provably IS live must show up, or the tool is blind. */
  if (CONTROL) {
    const r = await kill([CONTROL]);
    if (!r.killed)
      throw new Error(
        `STOP: control selector not found in any sheet: ${CONTROL}`,
      );
    await sleep(300);
    const after = await snapshot();
    const d = diffSnaps(before2, after).filter(
      (c) => !FLOOR.has(c.split(" ")[1]),
    );
    await restore();
    console.log(
      `control (${CONTROL}): ${d.length} change(s) ${d.length > 0 ? "PASS — the probe can see a rule" : "FAIL — probe is blind, no verdict below is worth anything"}`,
    );
    for (const c of d.slice(0, 4)) console.log(`   ${c}`);
    if (d.length === 0)
      throw new Error(
        "STOP: control rule produced no visible difference; the probe is blind",
      );
    await sleep(300);
  }

  const run = async (sels: string[], label: string) => {
    const base = await snapshot();
    const r = await kill(sels);
    await sleep(300);
    const after = await snapshot();
    const d = diffSnaps(base, after).filter((c) => !FLOOR.has(c.split(" ")[1]));
    await restore();
    await sleep(300);
    /* Put the rules back and re-measure. Anything that ALSO differs now is the
	   page changing under us — a live elapsed timer, a streaming reply — not
	   something the deleted rules were doing. Without this the verdict depends
	   on whether the clock happened to tick between two snapshots. */
    const churn = new Set(
      diffSnaps(base, await snapshot()).map((c) => c.split(" ")[1]),
    );
    const real = d.filter((c) => !churn.has(c.split(" ")[1]));
    if (churn.size)
      console.log(
        `   (page churn during the run, excluded: ${churn.size} element(s))`,
      );
    if (r.missing.length)
      console.log(`   (NOT FOUND: ${r.missing.join(" | ")})`);
    console.log(`   from: ${JSON.stringify(r.sheets)}`);
    // Nothing killed is not a verdict. It means the selectors in the targets
    // file don't match any rule in any sheet — usually a typo, or a rule that
    // has already been deleted — and reporting that as DEAD is the same
    // vacuous answer as measuring a rule on a page it never matches.
    const verdict =
      r.killed === 0
        ? "NO RULE MATCHED — nothing was measured"
        : real.length
          ? "LIVE"
          : "DEAD";
    console.log(
      `${label}: killed ${r.killed} rule(s) => ${real.length} change(s) ${verdict}`,
    );
    for (const c of real.slice(0, 12)) console.log(`   ${c}`);
    if (real.length > 12) console.log(`   … ${real.length - 12} more`);
    await sleep(200);
    return real.length;
  };

  if (EACH) {
    for (const s of TARGETS) await run([s], `  ${s}`);
  } else {
    await run(TARGETS, "ALL TARGETS TOGETHER");
  }
} finally {
  await closeCdpTarget(PORT, target?.id);
  ws?.close();
  await releaseCdpBrowser(lease);
}
