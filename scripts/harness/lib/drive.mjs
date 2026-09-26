/**
 * Driving the app through its interface, for an item's exercise (§7: what
 * STATE.md reports is what was exercised this way).
 *
 * A thin layer over a page from `browser.mjs`: click by test id or by a
 * button's text, type the way React hears it, put a file into a file input,
 * read text, and shoot at a width. Every check goes to the run's verdict file.
 */
import path from "node:path";
import { sleep } from "./browser.mjs";

export function driver(page, origin, outDir) {
  const ev = (expression) => page.evaluate(expression);

  const d = {
    page,
    ev,
    sleep,

    async go(pathname, settle = 3000) {
      await page.goto(origin + pathname, settle);
    },

    /** A test id, or a button or link whose text is exactly this. Throws when absent. */
    async click(target, settle = 800) {
      const clicked = await ev(`(() => {
        const t = ${JSON.stringify(target)};
        let el = document.querySelector('[data-testid="' + t + '"]');
        if (!el) el = [...document.querySelectorAll('button,a,[role=button]')]
          .find((b) => b.textContent.trim().toLowerCase() === t.toLowerCase());
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()`);
      await sleep(settle);
      if (!clicked) throw new Error(`no such control: ${target}`);
    },

    /** Sets an input or textarea's value through React's own setter. */
    async type(selector, value, settle = 200) {
      const typed = await ev(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await sleep(settle);
      if (!typed) throw new Error(`no such field: ${selector}`);
    },

    /** A file from disk into a file input, as a person choosing it would. */
    async setFile(selector, filePath) {
      const { root } = await page.send("DOM.getDocument", { depth: 1 });
      const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error(`no such file input: ${selector}`);
      await page.send("DOM.setFileInputFiles", { nodeId, files: [filePath] });
    },

    async text(selector = "main") {
      return ev(`(document.querySelector(${JSON.stringify(selector)}) || document.body).innerText`);
    },

    /** Polls an expression until it is truthy, a second at a time. */
    async until(expression, seconds = 60) {
      for (let i = 0; i < seconds; i += 1) {
        if (await ev(expression)) return true;
        await sleep(1000);
      }
      return false;
    },

    /** The whole page at a width, with the overflow it has. */
    async shoot(name, width, mobile) {
      await page.size(width, mobile ? 800 : 900, mobile);
      await sleep(700);
      const height = await ev("Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)");
      const overflow = await ev("document.documentElement.scrollWidth - document.documentElement.clientWidth");
      await page.size(width, Math.min(Math.max(height, mobile ? 800 : 900), 8000), mobile);
      await sleep(500);
      await page.shot(path.join(outDir, `${name}.png`));
      await page.size(width, mobile ? 800 : 900, mobile);
      return { file: `${name}.png`, height, overflow };
    },

    /** What is on screen now, a sheet included, at a width. */
    async shootViewport(name, width, height, mobile) {
      await page.size(width, height, mobile);
      await sleep(600);
      const overflow = await ev("document.documentElement.scrollWidth - document.documentElement.clientWidth");
      await page.shot(path.join(outDir, `${name}.png`));
      return { file: `${name}.png`, overflow };
    },
  };
  return d;
}
