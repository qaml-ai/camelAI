---
name: testing-debugging
description: Debug issues and write tests for deployed applications. Use this skill when the user reports bugs, wants to add tests, or needs help troubleshooting. Covers unit testing for rapid iteration, browser console debugging, and systematic bug reproduction.
license: Complete terms in LICENSE.txt
---

# Testing and Debugging

This skill guides debugging deployed applications and writing tests for rapid iteration. The key insight: **unit tests are the fastest way to reproduce and fix bugs**.

## The Unit Test Debugging Workflow

**This is the most effective debugging workflow.** Instead of repeatedly deploying and manually testing in the browser, write a unit test that reproduces the bug:

### Why Unit Tests for Debugging?

| Approach | Cycle Time | Reliability |
|----------|------------|-------------|
| Deploy → Browser → Manual test | 30-60 seconds | Variable |
| Run unit test | 1-2 seconds | Consistent |

A 30x speedup means you can iterate 30 times faster. This compounds: what takes an hour with manual testing takes 2 minutes with unit tests.

### The Workflow

1. **Understand the bug** - Read the user report, check console errors, understand expected vs actual behavior

2. **Write a failing test** - Create a test that reproduces the exact failure
   ```typescript
   // Example: User reports "discount not applied to cart total"
   test('applies discount code to cart total', () => {
     const cart = createCart([
       { name: 'Widget', price: 100 },
       { name: 'Gadget', price: 50 }
     ]);

     cart.applyDiscount('SAVE20'); // 20% off

     expect(cart.total).toBe(120); // Was returning 150
   });
   ```

3. **Run the test to confirm it fails** - Verify you've reproduced the bug
   ```bash
   bun test
   ```

4. **Fix the code** - Make changes to fix the failing test

5. **Run the test again** - Confirm the fix works
   ```bash
   bun test
   ```

6. **Deploy** - Once tests pass, publish through the mediated project tool (not a package-manager or Wrangler deploy command)
   ```js
   await tools.deploy_project({ project: "<project-name>" });
   ```

### Test File Location

Place test files next to the code they test:

```
src/
  cart.ts
  cart.test.ts      # Tests for cart.ts
  utils/
    discount.ts
    discount.test.ts
```

Or use a `__tests__` directory:

```
src/
  cart.ts
  __tests__/
    cart.test.ts
```

## Writing Effective Debug Tests

### Isolate the Problem

Test the smallest unit that could be failing:

```typescript
// Bad: Tests too much, hard to pinpoint failure
test('checkout flow works', async () => {
  await addToCart(item);
  await applyDiscount('CODE');
  await enterShipping(address);
  await processPayment(card);
  expect(order.status).toBe('complete');
});

// Good: Isolates the discount logic
test('applyDiscount calculates percentage correctly', () => {
  const subtotal = 100;
  const result = applyDiscount(subtotal, { type: 'percent', value: 20 });
  expect(result).toBe(80);
});
```

### Test Edge Cases

Bugs often hide in edge cases:

```typescript
test('handles empty cart', () => {
  const cart = createCart([]);
  expect(cart.total).toBe(0);
});

test('handles negative quantities', () => {
  const cart = createCart([{ name: 'Widget', price: 100, quantity: -1 }]);
  expect(cart.total).toBe(0); // Should not allow negative
});

test('handles very large numbers', () => {
  const cart = createCart([{ name: 'Widget', price: 999999.99, quantity: 1000 }]);
  expect(cart.total).toBeCloseTo(999999990); // Check for floating point issues
});
```

### Mock External Dependencies

Isolate your code from APIs and databases:

```typescript
import { vi } from 'vitest';

test('displays error when API fails', async () => {
  // Mock the fetch to simulate API failure
  vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

  const result = await loadUserData('user-123');

  expect(result.error).toBe('Failed to load user data');
});
```

## Browser Console Debugging

When you need to debug in the browser:

### Check Console Errors

Open browser DevTools (F12) and look for:
- Red error messages
- Failed network requests (Network tab)
- Uncaught exceptions

### Add Strategic Console Logs

```typescript
function calculateTotal(items: Item[], discount?: Discount) {
  console.log('calculateTotal called with:', { items, discount });

  const subtotal = items.reduce((sum, item) => {
    console.log('Processing item:', item, 'Running sum:', sum);
    return sum + item.price * item.quantity;
  }, 0);

  console.log('Subtotal:', subtotal);

  if (discount) {
    const discounted = applyDiscount(subtotal, discount);
    console.log('After discount:', discounted);
    return discounted;
  }

  return subtotal;
}
```

### Use Debugger Statement

Add `debugger;` to pause execution:

```typescript
function processOrder(order: Order) {
  debugger; // Browser will pause here when DevTools is open
  // ... rest of function
}
```

## Common Bug Patterns

### Off-by-One Errors

```typescript
// Bug: Loop skips last item
for (let i = 0; i < items.length - 1; i++) { ... }

// Fix: Include last item
for (let i = 0; i < items.length; i++) { ... }
```

### Async/Await Issues

```typescript
// Bug: Not awaiting async function
function loadData() {
  const data = fetchData(); // Returns Promise, not data!
  return processData(data);
}

// Fix: Await the promise
async function loadData() {
  const data = await fetchData();
  return processData(data);
}
```

### Type Coercion

```typescript
// Bug: String concatenation instead of addition
const total = price + tax; // "100" + "10" = "10010"

// Fix: Parse numbers
const total = Number(price) + Number(tax); // 110
```

### Null/Undefined Access

```typescript
// Bug: Accessing property on undefined
const name = user.profile.name; // Crashes if profile is undefined

// Fix: Optional chaining
const name = user?.profile?.name ?? 'Unknown';
```

## Test Commands

```bash
# Run all tests
bun test

# Run tests in watch mode (re-runs on file changes)
bun test --watch

# Run a specific test file
bun test src/cart.test.ts

# Run tests matching a pattern
bun test -t "discount"

# Run with coverage report
bun test --coverage
```

## Visual Verification

Screenshots and browser sessions are opt-in verification tools, not an automatic post-deploy step. A successful deploy is enough for routine build-and-ship requests. Use these tools when the user asks for visual/browser/E2E verification, the task is specifically diagnosing a deployed UI/runtime issue, or browser evidence is explicitly required.

For a requested deployed app UI check, use js_exec:

```javascript
await env.SCREENSHOT.capture({ scriptName: "my-app", path: "/" });
// or
await tools.take_screenshot({ script_name: "my-app", path: "/" });
```

This uses Cloudflare Browser Rendering through the platform binding, including
for access-controlled apps. Prefer unit/integration tests with Vitest for logic
and API behavior.

## Interactive Browser Testing

For requested or task-required end-to-end checks of a deployed app — clicking
buttons, filling forms, asserting rendered text, catching console errors —
launch an interactive browser session in js_exec with `env.BROWSER`. Do not add
this pass automatically after a successful deploy. It runs on Cloudflare
Browser Rendering (access-controlled apps included) and exposes a
Playwright-style API:

```javascript
const b = await env.BROWSER.launch({ scriptName: "my-app", path: "/" });
try {
  await b.fill("#todo-input", "buy milk");
  await b.click("button[type=submit]");
  await b.waitForText("buy milk");           // throws if it never appears
  if (!await b.hasText("buy milk")) throw new Error("todo is not visible");
  const count = await b.count(".todo-item");
  if (count !== 1) throw new Error(`expected 1 todo, got ${count}`);
  const logs = await b.logs();               // { console, pageErrors, requestFailures }
  if (logs.pageErrors.length) throw new Error(`page errors: ${logs.pageErrors.join("; ")}`);
} finally {
  await b.close();
}
```

Other session methods: `goto`, `type`, `press`, `select`, `hover`, `waitForSelector`, `waitForFunction`, `waitForTimeout` (fixed sleep in ms — prefer the condition-based waits), `evaluate` (run JS in the page), `textContent` (no selector returns visible body text), `hasText` (immediate boolean check), `getAttribute`, `exists`, `content` (HTML), `url`, `title`, `screenshot`. `press(key)` dispatches to the currently focused element/page; pass `{ selector }` to focus first, and verify its effect from UI state rather than assuming an application listener handled it. Run `await tools.help({ runtime: "env.BROWSER" })` for full usage. Keep the whole test inside one js_exec call, always `close()` the session, and note sessions auto-close after 5 minutes.

**Limitation:** for **access-controlled** apps, server-streamed responses (Server-Sent
Events / streaming `fetch`) are buffered by the session's request proxy, so
realtime/SSE-driven UI updates will not arrive mid-session. Standard
request/response and interaction testing works normally. A public deploy avoids
this proxy limitation only when the user has authorized public visibility and
no deployment-wide self-host ingress policy overrides it. Otherwise, use direct
authenticated browser/E2E coverage where available, or unit/integration tests
for the streaming path.

### When to Use Visual Checks vs Unit Tests

| Scenario | Approach |
|----------|----------|
| Logic bug in a function | Unit test (faster) |
| Visual layout issue | js_exec screenshot |
| Form submission flow | `env.BROWSER` session against the deployed app |
| Multi-step user flow on the deployed app | `env.BROWSER` session |
| API response handling | Unit test with mocks |
| Deployed app smoke check | `env.SCREENSHOT.capture` |
| Console/runtime errors on a deployed page | `env.BROWSER` session `logs()` |

## Debugging Checklist

When investigating a bug:

1. [ ] Read the user report carefully
2. [ ] Check browser console for errors
3. [ ] Identify the smallest reproducible case
4. [ ] Write a failing unit test
5. [ ] Fix the code
6. [ ] Verify test passes
7. [ ] Check for similar bugs elsewhere
8. [ ] Deploy and verify in production
