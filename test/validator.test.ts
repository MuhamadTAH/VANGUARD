import test from "node:test";
import assert from "node:assert/strict";
import {
  VanguardValidationError,
  buildVanguardIdentityState,
  validateVanguardOutput
} from "../src/logic/validator";

function expectValidationFailure(
  code: string,
  previousState: Map<string, string>,
  expectedCode: "VALIDATION_ERROR" | "DUPLICATE_ID_ERROR" | "MUTATION_ERROR"
): void {
  assert.throws(
    () => validateVanguardOutput(code, previousState),
    (error: unknown) => {
      assert.ok(error instanceof VanguardValidationError);
      assert.equal(error.code, expectedCode);
      return true;
    }
  );
}

test("Sample A: missing v-id on named component throws VALIDATION_ERROR", () => {
  const previous = buildVanguardIdentityState(`
    export function Screen() {
      return (
        <main v-id="main-1">
          <HeroBanner v-id="hero-1" />
        </main>
      );
    }
  `);

  const incoming = `
    export function Screen() {
      return (
        <main v-id="main-1">
          <HeroBanner />
        </main>
      );
    }
  `;

  expectValidationFailure(incoming, previous, "VALIDATION_ERROR");
});

test("Sample B: duplicate IDs throw DUPLICATE_ID_ERROR", () => {
  const previous = buildVanguardIdentityState(`
    export function App() {
      return (
        <main v-id="main-1">
          <Card v-id="card-1" />
          <Card v-id="card-2" />
        </main>
      );
    }
  `);

  const incoming = `
    export function App() {
      return (
        <main v-id="main-1">
          <Card v-id="card-1" />
          <Card v-id="card-1" />
        </main>
      );
    }
  `;

  expectValidationFailure(incoming, previous, "DUPLICATE_ID_ERROR");
});

test("Sample C: valid change with new unique v-id passes", () => {
  const previous = buildVanguardIdentityState(`
    export function Page() {
      return (
        <main v-id="main-1">
          <Hero v-id="hero-1" />
        </main>
      );
    }
  `);

  const incoming = `
    export function Page() {
      return (
        <main v-id="main-1">
          <Hero v-id="hero-1" />
          <FeaturePanel v-id="feature-1" />
        </main>
      );
    }
  `;

  assert.doesNotThrow(() => validateVanguardOutput(incoming, previous));
});

test("Sample D: identity mutation throws MUTATION_ERROR", () => {
  const previous = buildVanguardIdentityState(`
    export function Area() {
      return (
        <main v-id="main-1">
          <button v-id="cta-1">Start</button>
        </main>
      );
    }
  `);

  const incoming = `
    export function Area() {
      return (
        <main v-id="main-1">
          <section v-id="cta-1">Start</section>
        </main>
      );
    }
  `;

  expectValidationFailure(incoming, previous, "MUTATION_ERROR");
});

test("Sample E: missing v-id on layout tag throws VALIDATION_ERROR", () => {
  const previous = buildVanguardIdentityState(`
    export function Shell() {
      return (
        <main v-id="main-1">
          <header v-id="header-1" />
        </main>
      );
    }
  `);

  const incoming = `
    export function Shell() {
      return (
        <main v-id="main-1">
          <header />
        </main>
      );
    }
  `;

  expectValidationFailure(incoming, previous, "VALIDATION_ERROR");
});
