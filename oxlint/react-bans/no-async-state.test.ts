import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'
import plugin from './plugin.js'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'tsx' } },
})

tester.run('no-async-state', plugin.rules['no-async-state'], {
  valid: [
    `import { useState } from "react";
     function Menu() {
       const [open, setOpen] = useState(false);
       return <button onClick={() => setOpen(!open)} />;
     }`,
    `import { useState } from "react";
     function SignUp() {
       const [form, setForm] = useState({ email: "", name: "" });
       return <input value={form.email} onChange={(e) => setForm({ ...form, email: e.currentTarget.value })} />;
     }`,
    `import { useState } from "react";
     function Save() {
       const [note, setNote] = useState("");
       const save = useMutation({ mutationFn: api, onSuccess: () => queryClient.invalidateQueries() });
       return <button onClick={() => save.mutate(note)} />;
     }`,
    `import { useState } from "react";
     function Timer() {
       const [done, setDone] = useState(false);
       return <button onClick={() => setTimeout(() => setDone(true), 100)} />;
     }`,
    `async function load(setData) { setData(await api()); }`,
  ],
  invalid: [
    {
      code: `import { useState } from "react";
             function Save() {
               const [saving, setSaving] = useState(false);
               async function save() {
                 setSaving(true);
                 await api();
                 setSaving(false);
               }
               return <button disabled={saving} onClick={save} />;
             }`,
      errors: [{ messageId: 'banned' }, { messageId: 'banned' }],
    },
    {
      code: `import { useState } from "react";
             function List() {
               const [data, setData] = useState(null);
               return <button onClick={() => api().then((r) => setData(r))} />;
             }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import { useState } from "react";
             function List() {
               const [data, setData] = useState(null);
               return <button onClick={() => api().then(setData)} />;
             }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import * as React from "react";
             function List() {
               const [failed, setFailed] = React.useState(false);
               return <button onClick={() => api().catch(() => setFailed(true))} />;
             }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import { useState as useLocal } from "react";
             function Save() {
               const [step, setStep] = useLocal("form");
               const save = useMutation({ mutationFn: api, onSuccess: () => setStep("done") });
               return <button onClick={() => save.mutate()} />;
             }`,
      errors: [{ messageId: 'banned' }],
    },
    {
      code: `import { useState } from "react";
             function Save() {
               const [error, setError] = useState(null);
               const save = useMutation({ mutationFn: api, onError: setError });
               return <button onClick={() => save.mutate()} />;
             }`,
      errors: [{ messageId: 'banned' }],
    },
  ],
})
