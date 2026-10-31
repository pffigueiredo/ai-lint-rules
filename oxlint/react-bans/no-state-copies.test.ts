import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'
import plugin from './plugin.js'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'tsx' } },
})

tester.run('no-state-copies', plugin.rules['no-state-copies'], {
  valid: [
    `import { useState } from "react";
     function SignUp() {
       const [form, setForm] = useState({ email: "", name: "" });
       return <input value={form.email} onChange={(e) => setForm({ ...form, email: e.currentTarget.value })} />;
     }`,
    `import { useState } from "react";
     function EditVenue(props: Props) {
       const [draft, setDraft] = useState(props.initialVenue);
     }`,
    `import { useState } from "react";
     function EditVenue({ initialVenue, defaultName }: Props) {
       const [draft] = useState(initialVenue);
       const [name] = useState(defaultName);
     }`,
    `import { useState } from "react";
     function useCounter(initialCount: number) {
       return useState(initialCount);
     }`,
    `import { useState } from "react";
     function useDraft(initialVenue: Venue) {
       return useState(initialVenue.name);
     }`,
    `import { useState } from "react";
     function Days() {
       const [day, setDay] = useState("Mon");
       return DAYS.map((d) => <button key={d} onClick={() => setDay(d)}>{d}</button>);
     }`,
    `import { useState } from "react";
     function Picker(props: Props) {
       const [slug, setSlug] = useState(null);
       return props.venues.map((v) => <button key={v.slug} onClick={() => setSlug(v.slug)}>{v.name}</button>);
     }`,
  ],
  invalid: [
    {
      code: `import { useState } from "react";
             function Title(props: Props) {
               const [name] = useState(props.venue.name);
             }`,
      errors: [{ messageId: 'prop', data: { name: 'props.venue' } }],
    },
    {
      code: `import { useState } from "react";
             function useTitle(venue: Venue) {
               return useState(venue.name);
             }`,
      errors: [{ messageId: 'prop', data: { name: 'venue.name' } }],
    },
    {
      code: `import { useState } from "react";
             function Title({ venue }: Props) {
               const [current] = useState(venue);
             }`,
      errors: [{ messageId: 'prop', data: { name: 'venue' } }],
    },
    {
      code: `import { useState } from "react";
             function Title({ venue }: Props) {
               const [name] = useState(() => venue.name);
             }`,
      errors: [{ messageId: 'prop', data: { name: 'venue' } }],
    },
    {
      code: `import { useState } from "react";
             function Picker(props: Props) {
               const [selected, setSelected] = useState(null);
               return props.venues.map((v) => <button key={v.slug} onClick={() => setSelected(v)}>{v.name}</button>);
             }`,
      errors: [{ messageId: 'item', data: { name: 'v' } }],
    },
    {
      code: `import { useState } from "react";
             function Best(props: Props) {
               const [best, setBest] = useState(null);
               props.venues.forEach((v) => { if (v.visit) setBest(v); });
             }`,
      errors: [{ messageId: 'item', data: { name: 'v' } }],
    },
  ],
})
