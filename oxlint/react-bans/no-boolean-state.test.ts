import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'
import plugin from './plugin.js'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'tsx' } },
})

tester.run('no-boolean-state', plugin.rules['no-boolean-state'], {
  valid: [
    `import { useState } from "react";
     function Editor() { const [mode, setMode] = useState<"view" | "editing" | "confirming">("view"); }`,
    `import { useState } from "react";
     function Search() { const [query, setQuery] = useState(""); const [page, setPage] = useState(0); }`,
    `import { useState } from "react";
     function Picker() { const [slug, setSlug] = useState<string | null>(null); }`,
    `import { useState } from "react";
     function SignUp() {
       const [form, setForm] = useState({ email: "", name: "" });
       return <input value={form.email} onChange={(e) => setForm({ ...form, email: e.currentTarget.value })} />;
     }`,
    `function Terms() {
       return <form onSubmit={(e) => submit(new FormData(e.currentTarget))}><input type="checkbox" name="terms" /></form>;
     }`,
    `function Menu() { return <details><summary>Menu</summary></details>; }`,
  ],
  invalid: [
    {
      code: `import { useState } from "react";
             function Menu() { const [open, setOpen] = useState(false); }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import { useState } from "react";
             function Menu() {
               const [a] = useState<boolean>();
               const [b] = useState<boolean | null>(null);
               const [c] = useState<{ open: boolean }>(initial);
             }`,
      errors: [{ messageId: 'banned' }, { messageId: 'banned' }, { messageId: 'banned' }],
    },
    {
      code: `import { useState } from "react";
             function Flags(props: Props) {
               const [a] = useState(!props.hidden);
               const [b] = useState(Boolean(props.error));
               const [c] = useState(props.count > 0);
               const [d] = useState(() => false);
             }`,
      errors: [{ messageId: 'banned' }, { messageId: 'banned' }, { messageId: 'banned' }, { messageId: 'banned' }],
    },
    {
      code: `import { useState } from "react";
             function Editor() { const [ui, setUi] = useState({ editing: false, confirming: false }); }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import { useState } from "react";
             function SignUp() { const [form, setForm] = useState({ email: "", terms: false }); }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import * as React from "react";
             function Panel() { const [pinned] = React.useState(true); }`,
      errors: [{ messageId: 'banned' }],
    },
  ],
})
