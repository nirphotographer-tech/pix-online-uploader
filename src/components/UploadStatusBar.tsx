import { useState } from 'react';
import type { UploadSessionInfo } from '../../electron/preload';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatEta(seconds: number): string {
  if (seconds <= 0) return '--';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, '0')}h`;
}

interface UploadStatusBarProps {
  sessions: UploadSessionInfo[];
  onCancel: (sessionId: string) => void;
  onDismiss: (sessionId: string) => void;
}

export default function UploadStatusBar({ sessions, onCancel, onDismiss }: UploadStatusBarProps) {
  const [expanded, setExpanded] = useState(false);

  if (sessions.length === 0) return null;

  const activeSessions = sessions.filter((s) => s.status === 'uploading');
  const completedSessions = sessions.filter((s) => s.status === 'done');
  const errorSessions = sessions.filter((s) => s.status === 'error');

  const totalFiles = sessions.reduce((sum, s) => sum + s.totalFiles, 0);
  const totalCompleted = sessions.reduce((sum, s) => sum + s.completedFiles, 0);
  const totalFailed = sessions.reduce((sum, s) => sum + s.failedFiles, 0);
  const totalSize = sessions.reduce((sum, s) => sum + s.totalSize, 0);
  const totalLoaded = sessions.reduce((sum, s) => sum + s.totalLoaded, 0);
  const overallPercentage = totalSize > 0 ? Math.round((totalLoaded / totalSize) * 100) : 0;
  const totalSpeed = activeSessions.reduce((sum, s) => sum + s.speed, 0);

  const allDone = activeSessions.length === 0;
  const hasErrors = totalFailed > 0 || errorSessions.length > 0;

  // Color states
  const barColor = !allDone
    ? 'from-brand-primary to-brand-hover'
    : hasErrors
    ? 'from-amber-500 to-yellow-500'
    : 'from-emerald-500 to-green-400';

  const iconBg = !allDone
    ? 'bg-brand-primary/15'
    : hasErrors
    ? 'bg-amber-500/15'
    : 'bg-emerald-500/15';

  const dismissAll = () => {
    completedSessions.forEach((s) => onDismiss(s.sessionId));
    errorSessions.forEach((s) => onDismiss(s.sessionId));
  };

  return (
    <div className="fixed bottom-4 left-4 z-50 w-72 animate-slide-in" dir="rtl">
      <div className="bg-dark-card/98 backdrop-blur-sm border border-dark-border rounded-2xl shadow-2xl overflow-hidden">

        {/* Header row: icon + text + expand toggle + dismiss X */}
        <div className="flex items-center gap-2 px-3 py-2.5">
          {/* Expand/collapse toggle — only icon + summary text area */}
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-2 flex-1 min-w-0 text-right hover:opacity-80 transition-opacity"
          >
            {/* Status icon */}
            <div className={`flex-shrink-0 w-7 h-7 rounded-lg ${iconBg} flex items-center justify-center`}>
              {!allDone ? (
                <svg className="animate-spin w-3.5 h-3.5 text-brand-primary" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : hasErrors ? (
                <svg className="w-3.5 h-3.5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>

            {/* Summary text */}
            <div className="flex-1 min-w-0">
              {!allDone ? (
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] text-gray-800 font-medium">
                      מעלה {totalCompleted}/{totalFiles} תמונות
                    </span>
                    <span className="text-[10px] text-gray-500">{formatSpeed(totalSpeed)}</span>
                  </div>
                  <div className="w-full h-1 bg-dark-bg rounded-full overflow-hidden mt-1">
                    <div
                      className={`h-full bg-gradient-to-l ${barColor} rounded-full transition-all duration-500 ease-out`}
                      style={{ width: `${overallPercentage}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between mt-0.5">
                    <span className="text-[10px] text-gray-500">{overallPercentage}%</span>
                    <span className="text-[10px] text-gray-500">
                      ETA: {formatEta(totalSpeed > 0 ? Math.round((totalSize - totalLoaded) / totalSpeed) : 0)}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className={`text-[12px] font-medium ${hasErrors ? 'text-amber-500' : 'text-emerald-600'}`}>
                    {totalCompleted} תמונות הועלו בהצלחה
                  </span>
                  {totalFailed > 0 && (
                    <span className="text-[10px] text-red-400/80 bg-red-500/10 px-1.5 py-0.5 rounded-md">
                      {totalFailed} נכשלו
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Expand arrow */}
            <svg
              className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-200 flex-shrink-0 ${expanded ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>

          {/* Dismiss X — completely separate button, always visible when all done */}
          {allDone && (
            <button
              onClick={dismissAll}
              className="flex-shrink-0 w-6 h-6 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-dark-hover transition-all"
              title="סגור"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Expanded session list */}
        {expanded && (
          <div className="border-t border-dark-border max-h-48 overflow-y-auto animate-fade-in">
            {sessions.map((session) => {
              const sessionColor =
                session.status === 'uploading'
                  ? 'from-brand-primary to-brand-hover'
                  : session.status === 'error' || session.failedFiles > 0
                  ? 'from-red-500 to-red-400'
                  : 'from-emerald-500 to-green-400';

              return (
                <div
                  key={session.sessionId}
                  className="flex items-center gap-2.5 px-3 py-2 hover:bg-dark-hover/50 border-b border-dark-border/50 last:border-b-0 transition-colors"
                >
                  {/* Status dot */}
                  <div className="flex-shrink-0">
                    {session.status === 'uploading' ? (
                      <div className="w-2 h-2 rounded-full bg-brand-primary animate-pulse" />
                    ) : session.status === 'done' ? (
                      <div className="w-2 h-2 rounded-full bg-emerald-400" />
                    ) : (
                      <div className="w-2 h-2 rounded-full bg-red-400" />
                    )}
                  </div>

                  {/* Session info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                      <span className="text-[11px] text-gray-700 truncate font-medium">{session.galleryName}</span>
                      {session.folderName !== 'כל הגלריה' && (
                        <span className="text-[11px] text-gray-500 truncate">/ {session.folderName}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[10px] text-gray-500">
                        {session.completedFiles}/{session.totalFiles}
                      </span>
                      {session.status === 'uploading' && (
                        <>
                          <div className="w-10 h-1 bg-dark-bg rounded-full overflow-hidden">
                            <div
                              className={`h-full bg-gradient-to-l ${sessionColor} rounded-full transition-all duration-300`}
                              style={{ width: `${session.percentage}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-gray-500">{session.percentage}%</span>
                          <span className="text-[10px] text-gray-500">{formatSpeed(session.speed)}</span>
                        </>
                      )}
                      {session.failedFiles > 0 && (
                        <span className="text-[10px] text-red-400">{session.failedFiles} נכשלו</span>
                      )}
                    </div>
                  </div>

                  {/* Cancel (uploading) */}
                  {session.status === 'uploading' && (
                    <button
                      onClick={() => onCancel(session.sessionId)}
                      className="flex-shrink-0 w-6 h-6 rounded-md bg-dark-bg/50 flex items-center justify-center text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
                      title="ביטול"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}

                  {/* Dismiss (done / error) */}
                  {(session.status === 'done' || session.status === 'error') && (
                    <button
                      onClick={() => onDismiss(session.sessionId)}
                      className="flex-shrink-0 w-6 h-6 rounded-md bg-dark-bg/50 flex items-center justify-center text-gray-500 hover:text-gray-700 hover:bg-dark-hover transition-all"
                      title="סגור"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}

            {/* Clear all completed + errors */}
            {(completedSessions.length + errorSessions.length) > 1 && (
              <div className="px-3 py-2 border-t border-dark-border flex justify-end">
                <button
                  onClick={dismissAll}
                  className="text-[11px] text-gray-500 hover:text-gray-700 transition-colors"
                >
                  נקה הכל
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
