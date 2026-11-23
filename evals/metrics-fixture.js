const a = 1
if (a) f()
if (a) {
  f()
}
if (a && b || c) g()
else h()
a ??= d
x ? y() : z()
for (item of items) use(item)
switch (a) {
  case 1:
    one()
    break
  default:
    other()
}
try {
  boom()
} catch {
  recover()
}
function inner(n = 1) {
  if (n) return n
}
