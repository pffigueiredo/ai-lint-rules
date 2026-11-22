import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'
import plugin from './plugin.js'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'tsx' } },
})

const readAndWrite = `function readMode() {
  return new URLSearchParams(window.location.search).get("mode");
}
function go(q: string) {
  history.pushState({}, "", "/?q=" + q);
  history.replaceState({}, "", "/");
  history.back();
  history.forward();
  history.go(-1);
  window.history.pushState({}, "", "/");
}`

tester.run('url-state-in-lib', plugin.rules['url-state-in-lib'], {
  valid: [
    {
      filename: 'src/lib/use-url.ts',
      code: readAndWrite,
    },
    `function search(q: string) {
       return fetch("/api/venues?" + new URLSearchParams({ q }).toString());
     }`,
    `function parse(href: string) {
       return new URL(href, "http://localhost");
     }`,
    `function App() {
       const location = { search: "" };
       return location.search;
     }`,
  ],
  invalid: [
    {
      code: `const q = window.location.search;`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `const href = document.location.href;`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `const q = globalThis.location.search;`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `const q = location.search;`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `history.pushState({}, "", "/?q=1");`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `history.replaceState({}, "", "/");`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `history.back();`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `history.forward();`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `history.go(-1);`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `window.history.pushState({}, "", "/");`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `const h = history;`,
      errors: [{ messageId: 'banned' }],
    },
    {
      filename: 'src/App.tsx',
      code: `import { useState } from "react";
             function readMode() {
               return new URLSearchParams(window.location.search).get("mode");
             }
             function App() {
               const [mode, setMode] = useState(readMode);
             }`,
      errors: [{ messageId: 'banned' }],
    },
  ],
})
