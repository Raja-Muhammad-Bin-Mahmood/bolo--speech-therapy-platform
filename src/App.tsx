import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { EvidenceTuningProvider } from "./context/EvidenceTuningContext";
import Welcome from "./pages/Welcome";
import Dashboard from "./pages/Dashboard";
import RecordingSession from "./pages/RecordingSession";
import SessionScript from "./pages/SessionScript";
import SessionDebate from "./pages/SessionDebate";
import Analysis from "./pages/Analysis";
import PageTransition from "./components/PageTransition";
import DevTuningPanel from "./components/DevTuningPanel";

export default function App() {
  return (
    <AuthProvider>
      <EvidenceTuningProvider>
        <BrowserRouter>
          <PageTransition>
            <Routes>
              <Route path="/" element={<Welcome />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/session" element={<RecordingSession />} />
              <Route path="/session/script" element={<SessionScript />} />
              <Route path="/session/debate" element={<SessionDebate />} />
              <Route path="/analysis" element={<Analysis />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </PageTransition>
        </BrowserRouter>
        {/* Hidden developer panel — Ctrl+Shift+D (global, every mode) */}
        <DevTuningPanel />
      </EvidenceTuningProvider>
    </AuthProvider>
  );
}