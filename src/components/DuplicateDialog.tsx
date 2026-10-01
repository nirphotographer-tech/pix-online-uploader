import { useEffect, useRef, useState } from 'react';
import type { DuplicateReport, PickedFile } from '../lib/duplicates';

/** Same dialog (and wording) as the website's upload — keep the two in step */

export type DuplicateChoice = 'replace' | 'all' | 'cancel' | 'retry';

export type DuplicateDialogState =
  | {
      kind: 'ask';
      report: DuplicateReport;
      total: number;
      folderName: string;
      /** folder id → name, for copies found in other folders */
      folderNames: Map<string, string>;
      /** Photos to be replaced that clients marked as favorites (null = unknown) */
      favoritedCount: number | null;
    }
  | { kind: 'failed'; total: number };

interface Props {
  state: DuplicateDialogState;
  onChoose: (choice: DuplicateChoice) => void;
}

const plural = (n: number, one: string, other: string) => (n === 1 ? one : other.replace('#', String(n)));

export default function DuplicateDialog({ state, onChoose }: Props) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [showFiles, setShowFiles] = useState(false);

  useEffect(() => {
    primaryRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onChoose('cancel'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onChoose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-[2px] animate-fade-in"
      dir="rtl"
      onClick={(e) => { if (e.target === e.currentTarget) onChoose('cancel'); }}
    >
      <div role="dialog" aria-modal="true" className="w-full max-w-md max-h-[90vh] flex flex-col bg-white rounded-2xl shadow-2xl animate-scale-in">
        {state.kind === 'failed'
          ? <Failed total={state.total} onChoose={onChoose} primaryRef={primaryRef} />
          : <Ask state={state} onChoose={onChoose} primaryRef={primaryRef} showFiles={showFiles} setShowFiles={setShowFiles} />}
      </div>
    </div>
  );
}

function Ask({
  state,
  onChoose,
  primaryRef,
  showFiles,
  setShowFiles,
}: {
  state: Extract<DuplicateDialogState, { kind: 'ask' }>;
  onChoose: (choice: DuplicateChoice) => void;
  primaryRef: React.RefObject<HTMLButtonElement | null>;
  showFiles: boolean;
  setShowFiles: (v: boolean) => void;
}) {
  const { report, total, folderName, folderNames, favoritedCount } = state;
  const newCount = report.newFiles.length;
  const editedCount = report.edited.length;
  const skipped = total - newCount - editedCount;

  const rows: Array<{ key: string; label: string; files: PickedFile[]; dot: string }> = [];
  if (report.identical.length) rows.push({ key: 'same', label: 'כבר בתיקייה הזו', files: report.identical, dot: 'bg-amber-400' });
  if (editedCount) rows.push({ key: 'edited', label: 'גרסה ערוכה של תמונה קיימת', files: report.edited.map((e) => e.file), dot: 'bg-sky-500' });
  report.inOtherFolders.forEach((files, id) => {
    rows.push({ key: `f-${id}`, label: `כבר בתיקייה "${folderNames.get(id) ?? 'אחרת'}"`, files, dot: 'bg-amber-400' });
  });
  report.uploading.forEach((files, name) => {
    rows.push({ key: `u-${name}`, label: `בהעלאה כרגע לתיקייה "${name}"`, files, dot: 'bg-violet-500' });
  });
  if (newCount) rows.push({ key: 'new', label: 'תמונות חדשות', files: report.newFiles, dot: 'bg-emerald-500' });

  const replaceParts = [
    editedCount > 0 && `${plural(editedCount, 'תמונה אחת תוחלף', '# יוחלפו')} בגרסה החדשה`,
    newCount > 0 && plural(newCount, 'תמונה חדשה אחת תעלה', '# חדשות יעלו'),
    skipped > 0 && plural(skipped, 'אחת שכבר קיימת לא תעלה שוב', '# שכבר קיימות לא יעלו שוב'),
  ].filter(Boolean) as string[];

  return (
    <>
      <div className="px-6 pt-6 pb-5 flex items-start gap-4">
        <div className="w-11 h-11 rounded-full bg-stone-100 flex items-center justify-center shrink-0">
          <svg className="w-5 h-5 text-stone-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </div>
        <div className="min-w-0 pt-0.5">
          <h2 className="text-lg font-semibold text-stone-900 leading-snug">חלק מהתמונות כבר בגלריה</h2>
          <p className="text-sm text-stone-500 mt-1 leading-relaxed">
            {total - newCount} מתוך {total} התמונות שבחרתם לתיקייה "{folderName}" כבר קיימות.
          </p>
        </div>
      </div>

      <div className="px-6 overflow-y-auto min-h-0">
        <ul className="rounded-xl border border-stone-200 divide-y divide-stone-100">
          {rows.map((row) => (
            <li key={row.key} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="flex items-center gap-2.5 min-w-0 text-sm text-stone-700">
                <span className={`w-2 h-2 rounded-full shrink-0 ${row.dot}`} />
                <span className="truncate">{row.label}</span>
              </span>
              <span className="text-sm font-semibold text-stone-900 tabular-nums">{row.files.length}</span>
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={() => setShowFiles(!showFiles)}
          className="mt-3 text-xs text-stone-500 hover:text-stone-800 underline underline-offset-4 decoration-stone-300"
        >
          {showFiles ? 'הסתרת שמות הקבצים' : 'הצגת שמות הקבצים'}
        </button>
        {showFiles && (
          <div className="mt-2 max-h-40 overflow-y-auto rounded-lg bg-stone-50 px-3 py-2 space-y-2">
            {rows.filter((r) => r.key !== 'new').map((row) => (
              <div key={row.key}>
                <p className="text-[11px] font-medium text-stone-500">{row.label}</p>
                <p className="text-xs text-stone-700 leading-relaxed break-words text-right" dir="ltr">
                  {row.files.map((f) => f.name).join(', ')}
                </p>
              </div>
            ))}
          </div>
        )}

        {editedCount > 0 && favoritedCount !== 0 && (
          <div className="mt-4 flex items-start gap-3 rounded-xl bg-amber-50 border border-amber-200/70 px-4 py-3">
            <svg className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
            <p className="text-sm text-amber-900 leading-relaxed">
              {favoritedCount === null
                ? 'אם לקוח סימן במועדפים תמונה שמוחלפת, הסימון יוסר ממנה.'
                : `${plural(favoritedCount, 'תמונה אחת מאלה שיוחלפו מסומנת', '# מהתמונות שיוחלפו מסומנות')} במועדפים של לקוחות. בהחלפה הסימון יוסר, כי זו כבר לא התמונה שהם בחרו.`}
            </p>
          </div>
        )}
      </div>

      <div className="px-6 pt-5 pb-6 space-y-2.5">
        <button
          ref={primaryRef}
          type="button"
          onClick={() => onChoose('replace')}
          className="w-full text-right rounded-xl bg-stone-900 hover:bg-stone-800 text-white px-4 py-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:ring-offset-2"
        >
          <span className="block text-[15px] font-semibold">החלפת התמונות הקיימות בחדשות</span>
          <span className="block text-xs text-white/70 mt-0.5 leading-relaxed">
            {replaceParts.length > 0 ? replaceParts.join(' · ') : 'כל התמונות כבר בגלריה, לא יועלה דבר'}
          </span>
        </button>
        <button
          type="button"
          onClick={() => onChoose('all')}
          className="w-full text-right rounded-xl border border-stone-200 bg-white hover:bg-stone-50 text-stone-900 px-4 py-3 transition-colors"
        >
          <span className="block text-[15px] font-semibold">העלאה בנוסף לתמונות הקיימות</span>
          <span className="block text-xs text-stone-500 mt-0.5 leading-relaxed">כל {total} התמונות יעלו, והקיימות יופיעו בגלריה פעמיים</span>
        </button>
        <button
          type="button"
          onClick={() => onChoose('cancel')}
          className="w-full rounded-xl py-2.5 text-sm text-stone-500 hover:text-stone-900 hover:bg-stone-50 transition-colors"
        >
          ביטול
        </button>
      </div>
    </>
  );
}

function Failed({
  total,
  onChoose,
  primaryRef,
}: {
  total: number;
  onChoose: (choice: DuplicateChoice) => void;
  primaryRef: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="p-6">
      <div className="flex items-start gap-4">
        <div className="w-11 h-11 rounded-full bg-stone-100 flex items-center justify-center shrink-0">
          <svg className="w-5 h-5 text-stone-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.008M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div className="pt-0.5">
          <h2 className="text-lg font-semibold text-stone-900">לא הצלחנו לבדוק כפילויות</h2>
          <p className="text-sm text-stone-500 mt-1 leading-relaxed">
            לא ברור אם {total} התמונות כבר נמצאות בגלריה. כנראה בעיית חיבור.
          </p>
        </div>
      </div>
      <div className="mt-6 space-y-2.5">
        <button
          ref={primaryRef}
          type="button"
          onClick={() => onChoose('retry')}
          className="w-full rounded-xl bg-stone-900 hover:bg-stone-800 text-white px-4 py-3 text-[15px] font-semibold transition-colors"
        >
          לבדוק שוב
        </button>
        <button
          type="button"
          onClick={() => onChoose('all')}
          className="w-full rounded-xl border border-stone-200 bg-white hover:bg-stone-50 text-stone-900 px-4 py-3 text-[15px] font-semibold transition-colors"
        >
          להעלות בכל זאת
        </button>
        <button
          type="button"
          onClick={() => onChoose('cancel')}
          className="w-full rounded-xl py-2.5 text-sm text-stone-500 hover:text-stone-900 hover:bg-stone-50 transition-colors"
        >
          ביטול
        </button>
      </div>
    </div>
  );
}
