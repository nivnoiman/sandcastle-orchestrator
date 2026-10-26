Code review target: $ARGUMENTS

## Check
1. **Bugs** — null access, race conditions, missing await, off-by-one, edge cases
2. **Security** — injection, XSS, unsanitized input, missing auth, exposed secrets, IDOR
3. **Types** — any usage, missing return types, unsafe assertions, loose generics
4. **Perf** — N+1 queries, missing indexes, unnecessary re-renders, no pagination, memory leaks
5. **Errors** — swallowed catches, generic messages, missing boundaries
6. **Quality** — dead code, SRP violations, magic values, duplication

## Output format
**file:line** — issue → fix
🔴 critical | 🟡 warning | 🔵 suggestion

Critical first. End with: "X critical, Y warnings, Z suggestions"
