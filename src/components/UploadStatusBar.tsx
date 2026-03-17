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

  // Calculate overall progress
  const totalFiles = sessions.reduce((sum, s) => sum + s.totalFiles, 0);
  const totalCompleted = sessions.reduce((sum, s) => sum + s.completedFiles, 0);
  const totalFailed = sessions.reduce((sum, s) => sum + s.failedFiles, 0);
  const totalSize = sessions.reduce((sum, s) => sum + s.totalSize, 0);
  const totalLoaded = sessions.reduce((sum, s) => sum + s.totalLoaded, 0);
  const overallPercentage = totalSize > 0 ? Math.round((totalLoaded / totalSize) * 100) : 0;
  const totalSpeed = activeSessions.reduce((sum, s) => sum + s.speed, 0);

  const allDone = activeSessions.length === 0;

  return (
    <div className="border-t border-dark-border bg-dark-card">
      {/* Summary bar — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-dark-hover transition-colors text-right"
      >
        {/* Status icon */}
        <div className="flex-shrink-0">
          {!allDone ? (
            <div className="relative w-5 h-5">
              <svg className="animate-spin w-5 h-5 text-brand-primary" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          ) : errorSessions.length > 0 ? (
            <svg className="w-5 h-5 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          ) : (
            <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          )}
        </div>

        {/* Summary text */}
        <div className="flex-1 min-w-0">
          {!allDone ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-300">
                מעלה {totalCompleted}/{totalFiles} תמונות
              </span>
              <span className="text-xs text-gray-500">
                {overallPercentage}% · {formatSpeed(totalSpeed)}
              </span>
            </div>
          ) : (
            <span className="text-sm text-gray-300">
              {totalCompleted} תמונות הועלו בהצלחה
              {totalFailed > 0 && ` · ${totalFailed} נכשלו`}
            </span>
          )}
        </div>

        {/* Progress mini-bar (only when uploading) */}
        {!allDone && (
          <div className="w-20 flex-shrink-0">
            <div className="w-full h-1.5 bg-dark-bg rounded-full overflow-hidden">
              <div
                className="h-full bg-brand-primary rounded-full transition-all duration-300"
                style={{ width: `${overallPercentage}%` }}
              />
            </div>
          </div>
        )}

        {/* Expand arrow */}
        <svg
          className={`w-4 h-4 text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
        </svg>
      </button>

      {/* Expanded session list */}
      {expanded && (
        <div className="border-t border-dark-border max-h-48 overflow-y-auto">
          {sessions.map((session) => (
            <div
              key={session.sessionId}
              className="flex items-center gap-3 px-4 py-2 hover:bg-dark-hover/50 border-b border-dark-border/50 last:border-b-0"
            >
              {/* Session status icon */}
              <div className="flex-shrink-0 w-4 h-4">
                {session.status === 'uploading' && (
                  <svg className="animate-spin w-4 h-4 text-brand-primary" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
                {session.status === 'done' && (
                  <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                )}
                {session.status === 'error' && (
                  <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                )}
              </div>

              {/* Session info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-300 truncate font-medium">{session.galleryName}</span>
                  {session.folderName !== 'כל הגלריה' && (
                    <span className="text-xs text-gray-600 truncate">/ {session.folderName}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[11px] text-gray-500">
                    {session.completedFiles}/{session.totalFiles} תמונות
                  </span>
                  {session.status === 'uploading' && (
                    <>
                      <span className="text-[11px] text-gray-600">{session.percentage}%</span>
                      <span className="text-[11px] text-gray-600">{formatSpeed(session.speed)}</span>
                      <span className="text-[11px] text-gray-600">ETA: {formatEta(session.eta)}</span>
                    </>
                  )}
                  {session.failedFiles > 0 && (
                    <span className="text-[11px] text-red-400">{session.failedFiles} נכשלו</span>
                  )}
                </div>
              </div>

              {/* Progress bar */}
              {session.status === 'uploading' && (
                <div className="w-16 flex-shrink-0">
                  <div className="w-full h-1 bg-dark-bg rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand-primary rounded-full transition-all duration-300"
                      style={{ width: `${session.percentage}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Action button */}
              {session.status === 'uploading' && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCancel(session.sessionId);
                  }}
                  className="flex-shrink-0 text-gray-500 hover:text-red-400 transition-colors p-1"
                  title="ביטול"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
              {(session.status === 'done' || session.status === 'error') && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDismiss(session.sessionId);
                  }}
                  className="flex-shrink-0 text-gray-600 hover:text-gray-400 transition-colors p-1"
                  title="סגור"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          ))}

          {/* Clear all completed */}
          {completedSessions.length > 1 && (
            <div className="px-4 py-1.5 border-t border-dark-border">
              <button
                onClick={() => {
                  completedSessions.forEach((s) => onDismiss(s.sessionId));
                  errorSessions.forEach((s) => onDismiss(s.sessionId));
                }}
                className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
              >
                נקה הכל
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
