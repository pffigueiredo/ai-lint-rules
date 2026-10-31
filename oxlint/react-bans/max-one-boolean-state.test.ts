import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'
import plugin from './plugin.js'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'tsx' } },
})

tester.run('max-one-boolean-state', plugin.rules['max-one-boolean-state'], {
  valid: [
    `import { useState } from "react";
     function Menu() {
       const [open, setOpen] = useState(false);
       const [query, setQuery] = useState("");
     }`,
    `import { useState } from "react";
     function A() { const [open] = useState(false); }
     function B() { const [open] = useState(true); }`,
    `import { useState } from "react";
     function SignUp() {
       const [form, setForm] = useState({ email: "", terms: false, newsletter: false });
     }`,
    `import { useState } from "react";
     function Editor() {
       const [mode, setMode] = useState<"view" | "editing" | "confirming">("view");
     }`,
  ],
  invalid: [
    {
      code: `import { useState } from "react";
             function Editor() {
               const [editing, setEditing] = useState(false);
               const [confirming, setConfirming] = useState(false);
             }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import { useState } from "react";
             function Save() {
               const [saving, setSaving] = useState<boolean>();
               const [saved, setSaved] = useState(!initial);
               const [failed, setFailed] = useState(Boolean(error));
             }`,
      errors: [{ messageId: 'banned' }, { messageId: 'banned' }],
    },
    {
      code: `import * as React from "react";
             function Panel() {
               const [open] = React.useState(true);
               const [pinned] = React.useState(false);
             }`,
      errors: [{ messageId: 'banned' }],
    },
  ],
})
