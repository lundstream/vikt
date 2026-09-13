import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell.js";
import { ConsentGate } from "./components/ConsentGate.js";
import { Settings } from "./routes/Settings.js";
import { News } from "./routes/News.js";
import { useQueueSync } from "./lib/queue/useQueue.js";
import { useMe } from "./lib/session.js";
import { LogDateProvider } from "./lib/log-date.js";
import { Login } from "./routes/Login.js";
import { Register } from "./routes/Register.js";
import { Dashboard } from "./routes/Dashboard.js";
import { Profile } from "./routes/Profile.js";
import { FoodLog } from "./routes/FoodLog.js";
import { DailyLog } from "./routes/DailyLog.js";
import { Data } from "./routes/Data.js";
import { Admin } from "./routes/Admin.js";
import { ResetPassword } from "./routes/ResetPassword.js";
import { Diagnostics } from "./routes/Diagnostics.js";
import { Progress } from "./routes/Progress.js";
import { Coach } from "./routes/Coach.js";
import { t } from "./i18n/index.js";

export function App() {
  const me = useMe();

  // Drains the queue on reconnect, on the tab becoming visible, and while
  // anything is pending. Mounted once, at the root, so it keeps running as the
  // user moves between screens.
  useQueueSync();

  if (me.isPending) {
    return (
      <div className="grid min-h-dvh place-items-center text-sm text-muted">
        <span role="status">{t("app.loading")}</span>
      </div>
    );
  }

  /**
   * The day Dagen and Mat are looking at, shared between them (D62). Mounted
   * above the router so it survives navigating between the two, and below the
   * session so it knows the user's timezone.
   */
  return (
    <LogDateProvider timezone={me.data?.profile.timezone ?? "Europe/Stockholm"}>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      {/* Both halves of the reset flow, one route (D88). */}
      <Route path="/nytt-losenord" element={<ResetPassword />} />
      <Route
        path="/"
        element={signedIn(me.data, <Dashboard />)}
      />
      <Route path="/installningar" element={signedIn(me.data, <Settings />)} />
      <Route path="/nyheter" element={signedIn(me.data, <News />)} />
      <Route path="/profile" element={signedIn(me.data, <Profile />)} />
      <Route path="/food" element={signedIn(me.data, <FoodLog />)} />
      <Route path="/dag" element={signedIn(me.data, <DailyLog />)} />
      {/*
        Samband is a tab inside Data now (D92). The old path is kept as a
        redirect rather than deleted: it is in browser histories and in at least
        one note, and a 404 there would be a worse answer than the right screen.
      */}
      <Route path="/samband" element={<Navigate to="/data?vy=samband" replace />} />
      <Route path="/data" element={signedIn(me.data, <Data />)} />
      <Route path="/framsteg" element={signedIn(me.data, <Progress />)} />
      {/*
        The Coach page (D139). Registered unconditionally here and reachable
        only through a navigation entry the LLM flag decides: the server does
        not serve its data with the layer off, so the screen renders its
        unavailable state rather than a 404 for somebody who typed the path.
      */}
      <Route path="/coach" element={signedIn(me.data, <Coach />)} />
      {/*
        Not linked from anywhere. It exists so the BarcodeDetector path can be
        checked on a real phone, which no headless browser can stand in for.
      */}
      {/*
        The admin view (D89). Guarded server-side by `requireAdmin`, which
        answers 404; this route simply renders what the API will or will not
        give it, so a non-admin who guesses the URL is told nothing.
      */}
      <Route path="/admin" element={signedIn(me.data, <Admin />)} />
      <Route path="/diagnostik" element={signedIn(me.data, <Diagnostics />)} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </LogDateProvider>
  );
}

/**
 * Every signed-in screen gets the shell; the auth screens deliberately do not.
 * A bottom bar on a login form navigates to places the visitor cannot reach.
 */
function signedIn(user: unknown, screen: ReactNode): ReactNode {
  if (!user) return <Navigate to="/login" replace />;
  /**
   * One gate, in one place (D107). An account that has not agreed to the
   * privacy text sees the question instead of the screen, and every signed-in
   * route goes through here, so there is no path that forgets.
   */
  return (
    <AppShell>
      <ConsentGate>{screen}</ConsentGate>
    </AppShell>
  );
}
