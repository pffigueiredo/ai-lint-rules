import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'
import plugin from './plugin.js'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'tsx' } },
})

tester.run('no-url-state-copy', plugin.rules['no-url-state-copy'], {
  valid: [
    `import { useState } from "react";
     function Counter() {
       const [n, setN] = useState(0);
     }`,
    `import { useState } from "react";
     function Form() {
       const [draft, setDraft] = useState({ city: "Madrid" });
     }`,
    `import { useReducer } from "react";
     function Counter() {
       const [n, dispatch] = useReducer((s: number) => s + 1, 0);
     }`,
    `import { useState } from "react";
     function inner() { return new URLSearchParams(window.location.search); }
     function outer() { return inner(); }
     function App() {
       const [n, setN] = useState(() => outer());
     }`,
    `import { useSearchParams } from "./lib/use-search-params";
     import { useState } from "react";
     function App() {
       const [params] = useSearchParams();
       const [n, setN] = useState(0);
       return params.get("q") ?? String(n);
     }`,
  ],
  invalid: [
    {
      code: `import { useState } from "react";
             function App() {
               const [mode, setMode] = useState(window.location.search);
             }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import { useState } from "react";
             function App() {
               const [mode, setMode] = useState(location.search);
             }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import { useState } from "react";
             function App() {
               const [mode, setMode] = useState(document.location.href);
             }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import { useState } from "react";
             function App() {
               const [params, setParams] = useState(new URLSearchParams(window.location.search));
             }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import { useState } from "react";
             function App() {
               const [params, setParams] = useState(() => new URLSearchParams(window.location.search));
             }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import { useState } from "react";
             function readMode() {
               return new URLSearchParams(window.location.search).get("mode");
             }
             function App() {
               const [mode, setMode] = useState(readMode);
             }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import { useState } from "react";
             function readMode() {
               return new URLSearchParams(window.location.search).get("mode");
             }
             function App() {
               const [mode, setMode] = useState(readMode());
             }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import { useState } from "react";
             const readMode = () => new URLSearchParams(window.location.search).get("mode");
             function App() {
               const [mode, setMode] = useState(readMode);
             }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import { useSearchParams } from "./lib/use-search-params";
             import { useState } from "react";
             function App() {
               const [params, setParams] = useState(useSearchParams()[0]);
             }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import { useSearch } from "@tanstack/react-router";
             import { useState } from "react";
             function App() {
               const [q, setQ] = useState(useSearch());
             }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import { useReducer } from "react";
             function readMode() {
               return new URLSearchParams(window.location.search).get("mode") ?? "list";
             }
             function App() {
               const [mode, dispatch] = useReducer((s: string) => s, readMode);
             }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import * as React from "react";
             function App() {
               const [q, setQ] = React.useState(window.location.search);
             }`,
      errors: [{ messageId: 'banned' }],
    },
  ],
})
