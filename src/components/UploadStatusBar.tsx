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

  return (
    <div className="border-t border-dark-border bg-dark-card/95 backdrop-blur-sm">
      {/* Summary bar */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-dark-hover transition-colors text-right"
      >
        {/* Status icon */}
        <div className={`flex-shrink-0 w-8 h-8 rounded-lg ${iconBg} flex items-center justify-center`}>
          {!allDone ? (
            <svg className="animate-spin w-4 h-4 text-brand-primary" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : hasErrors ? (
            <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          ) : (
            <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          )}
        </div>

        {/* Summary text */}
        <div className="flex-1 min-w-0">
          {!allDone ? (
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-gray-800 font-medium">
                  מעלה {totalCompleted}/{totalFiles} תמונות
                </span>
                <span className="text-[11px] text-gray-500">
                  {formatSpeed(totalSpeed)}
                </span>
              </div>
              {/* Inline progress bar */}
              <div className="w-full h-1.5 bg-dark-bg rounded-full overflow-hidden mt-1.5">
                <div
                  className={`h-full bg-gradient-to-l ${barColor} rounded-full transition-all duration-500 ease-out relative`}
                  style={{ width: `${overallPercentage}%` }}
                >
                  <div className="absolute inset-0 animate-progress-pulse rounded-full" />
                </div>
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-[10px] text-gray-600">{overallPercentage}%</span>
                <span className="text-[10px] text-gray-600">ETA: {formatEta(
                  totalSpeed > 0 ? Math.round((totalSize - totalLoaded) / totalSpeed) : 0
                )}</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className={`text-[13px] font-medium ${hasErrors ? 'text-amber-300' : 'text-emerald-300'}`}>
                {totalCompleted} תמונות הועלו בהצלחה
              </span>
              {totalFailed > 0 && (
                <span className="text-[11px] text-red-400/80 bg-red-500/10 px-1.5 py-0.5 rounded-md">
                  {totalFailed} נכשלו
                </span>
              )}
            </div>
          )}
        </div>

        {/* Expand arrow */}
        <svg
          className={`w-4 h-4 text-gray-600 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
        </svg>
      </button>

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
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-dark-hover/50 border-b border-dark-border/50 last:border-b-0 transition-colors"
              >
                {/* Session status dot */}
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
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-300 truncate font-medium">{session.galleryName}</span>
                    {session.folderName !== 'כל הגלריה' && (
                      <span className="text-xs text-gray-600 truncate">/ {session.folderName}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[11px] text-gray-500">
                      {session.completedFiles}/{session.totalFiles}
                    </span>
                    {session.status === 'uploading' && (
                      <>
                        <div className="w-12 h-1 bg-dark-bg rounded-full overflow-hidden">
                          <div
                            className={`h-full bg-gradient-to-l ${sessionColor} rounded-full transition-all duration-300`}
                            style={{ width: `${session.percentage}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-gray-600">{session.percentage}%</span>
                        <span className="text-[10px] text-gray-600">{formatSpeed(session.speed)}</span>
                      </>
                    )}
                    {session.failedFiles > 0 && (
                      <span className="text-[10px] text-red-400">{session.failedFiles} נכשלו</span>
                    )}
                  </div>
                </div>

                {/* Action button */}
                {session.status === 'uploading' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCancel(session.sessionId);
                    }}
                    className="flex-shrink-0 w-6 h-6 rounded-md bg-dark-bg/50 flex items-center justify-center
                               text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-all"
                    title="ביטול"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
                    className="flex-shrink-0 w-6 h-6 rounded-md bg-dark-bg/50 flex items-center justify-center
                               text-gray-600 hover:text-gray-400 transition-all"
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

          {/* Clear all completed */}
          {completedSessions.length > 1 && (
            <div className="px-4 py-2 border-t border-dark-border">
              <button
                onClick={() => {
                  completedSessions.forEach((s) => onDismiss(s.sessionId));
                  errorSessions.forEach((s) => onDismiss(s.sessionId));
                }}
                className="text-[11px] text-gray-600 hover:text-gray-300 transition-colors"
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
