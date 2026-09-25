/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export default function App() {
  return (
    <div style={{ padding: "40px", textAlign: "center" }}>
      <h1>اختبار ربط Sentry</h1>
      <button
        style={{
          padding: "10px 20px",
          fontSize: "16px",
          backgroundColor: "#e11d48",
          color: "#fff",
          border: "none",
          borderRadius: "6px",
          cursor: "pointer"
        }}
        onClick={() => {
          throw new Error("اختبار سنتري الأول!");
        }}
      >
        Break the world
      </button>
    </div>
  );
}
