import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Library,
  FolderOpen,
  Folder,
  Trash2,
  Plus,
  Search,
  Settings as SettingsIcon,
  Mic,
  Upload,
  ChevronRight,
  ChevronDown,
  MessageSquare,
  Sparkles,
  MoreHorizontal,
  ArrowUpRight,
  FileText,
  FileAudio,
  File,
  Languages as LanguagesIcon,
  Headphones,
  Pause,
  Play,
  Square,
  Check,
  ShieldCheck,
  WifiOff,
  AlertTriangle,
  RefreshCw,
  Download,
  Pencil,
  X,
  Send,
  History,
  PanelRightClose,
  KeyRound,
  HardDrive,
  Cloud,
  SlidersHorizontal,
  Clock,
  Circle,
  Zap,
  ClipboardList,
  ArrowLeft,
  CheckCircle2,
  LoaderCircle,
  ExternalLink,
  Keyboard,
  Pin,
  GripVertical,
  ListChecks,
} from 'lucide-react';
import type {
  AudioMode,
  AppEvent,
  Backup,
  ChatContext,
  ChatMessage,
  ChatMode,
  Conversation,
  CustomAction,
  Language,
  Lecture,
  LectureDetail,
  LibrarySnapshot,
  Material,
  Settings,
  Subject,
  Version,
} from '../shared/types';
import { DEFAULT_SETTINGS, MODEL_CATALOG } from '../shared/types';
import { AudioCapture } from './audio/recorder';
import { Button, Empty, Field, IconButton, Languages, Markdown, Modal, Select, Toggle } from './components';
import type { T } from './components';
import { languageNames, locale, size, time, translator, type TextKey } from './i18n';
import { autoLectureTitle } from '../shared/naming';
import { renderTranscript, segmentAt, transcriptUnits, turnPolicy } from '../shared/transcript';

type Catalog = { live: string[]; file: string[]; text: string[]; available: string[]; verified: boolean };
type Scope = 'all' | 'unfiled' | 'trash' | string;
type Pane = 'original' | 'versions' | 'translation' | 'notes' | 'materials';
type Notice = { id: number; type: 'success' | 'error' | 'info'; text: string };
type Perform = <T>(operation: () => Promise<T>, success?: string) => Promise<T | undefined>;
const actions: { id: string; label: TextKey; icon: typeof Sparkles }[] = [
  { id: 'summary', label: 'summary', icon: FileText },
  { id: 'notes', label: 'detailed_notes', icon: BookOpen },
  { id: 'make-notes', label: 'make_notes', icon: Pencil },
  { id: 'rephrase', label: 'rephrase', icon: RefreshCw },
  { id: 'simple', label: 'simplify', icon: Sparkles },
  { id: 'key-points', label: 'key_points', icon: ListChecks },
  { id: 'terms', label: 'terminology', icon: Library },
  { id: 'assignments', label: 'assignments', icon: ClipboardList },
  { id: 'questions', label: 'exam_questions', icon: MessageSquare },
  { id: 'flashcards', label: 'flashcards', icon: FileText },
  { id: 'translate', label: 'translate', icon: LanguagesIcon },
];
const call = <T,>(method: Parameters<Window['lecturedesk']['call']>[0], args?: unknown) =>
  window.lecturedesk.call<T>(method, args);
function dateLabel(date: string, lang: Language) {
  const value = new Date(date);
  return Number.isNaN(value.getTime())
    ? date
    : value.toLocaleDateString(locale(lang), { day: 'numeric', month: 'short', year: 'numeric' });
}
function versionLabel(kind: Version['kind'], t: T) {
  return t(
    (
      {
        original: 'original',
        edited: 'editedTitle',
        improved: 'improve',
        translation: 'translation',
        notes: 'notes',
        action: 'quickActions',
      } as const
    )[kind],
  );
}
function taskLabel(kind: string, t: T) {
  const labels: Record<string, TextKey> = {
    transcribe: 'original',
    'transcribe-range': 'original',
    improve: 'improve',
    action: 'quickActions',
    translation: 'translation',
    analysis: 'notes',
    'final-notes': 'finalNotes',
    finalize: 'original',
    chat: 'chat',
  };
  return labels[kind] ? t(labels[kind]) : kind;
}
function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand ${small ? 'small' : ''}`}>
      <span className="brand-mark">
        <BookOpen size={22} />
      </span>
      <span>
        Lecture<span className="brand-light">Desk</span>
      </span>
    </span>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [fatal, setFatal] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<LectureDetail | null>(null);
  const [scope, setScope] = useState<Scope>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest');
  const [tag, setTag] = useState('');
  const [searchResults, setSearchResults] = useState<Set<string> | null>(null);
  const [searching, setSearching] = useState(false);
  const [pane, setPane] = useState<Pane>('original');
  const [versionId, setVersionId] = useState('');
  const [compareId, setCompareId] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const [chatSeed, setChatSeed] = useState(0);
  const [showTasks, setShowTasks] = useState(false);
  const [modal, setModal] = useState<
    'settings' | 'subject' | 'lecture' | 'export' | 'improve' | 'actions' | 'shortcuts' | null
  >(null);
  const [editSubject, setEditSubject] = useState<Subject | null>(null);
  const [subjectMenu, setSubjectMenu] = useState<string | null>(null);
  const [lectureMenu, setLectureMenu] = useState(false);
  const [deleteSubject, setDeleteSubject] = useState<Subject | null>(null);
  const [clearTrashOpen, setClearTrashOpen] = useState(false);
  const [clearingTrash, setClearingTrash] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [selectedText, setSelectedText] = useState('');
  const [notices, setNotices] = useState<Notice[]>([]);
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<Record<string, { text: string; start?: number }>>({});
  // Action waiting for the one-time lecture language confirmation (recording or import).
  const [languagePrompt, setLanguagePrompt] = useState<null | (() => void)>(null);
  const languageChosen = useRef(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [drag, setDrag] = useState(false);
  const [importProgress, setImportProgress] = useState<number | null>(null);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [recordPaused, setRecordPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const capture = useRef<AudioCapture | null>(null);
  const recordClock = useRef({ elapsed: 0, at: 0 });
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const pendingSeek = useRef(0);
  const [playerUrl, setPlayerUrl] = useState('');
  const [playerSegment, setPlayerSegment] = useState('');
  const [playerTime, setPlayerTime] = useState(0);
  const [playerPlaying, setPlayerPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState('1');
  const playerRef = useRef<HTMLAudioElement>(null);
  const settings = snapshot?.settings || DEFAULT_SETTINGS;
  const t = translator(settings.uiLanguage);
  const searchFingerprint =
    (snapshot?.lectures || [])
      .map((l) => [l.id, l.title, l.topic, l.tags.join(','), l.activeVersionId, l.deletedAt].join(':'))
      .join('|') +
    '|' +
    (snapshot?.materials || []).map((m) => [m.id, m.status, m.pages.length].join(':')).join(',') +
    '|' +
    (snapshot?.tasks || [])
      .filter((t) => t.status === 'done')
      .map((t) => t.id)
      .join(',');
  const notify = useCallback((text: string, type: Notice['type'] = 'success') => {
    const id = Date.now() + Math.random();
    setNotices((n) => [...n.slice(-3), { id, type, text }]);
    if (type !== 'error') window.setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 7000);
  }, []);
  const perform: Perform = useCallback(
    async (operation, success) => {
      try {
        const result = await operation();
        if (success) notify(success);
        return result;
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e), 'error');
        return undefined;
      }
    },
    [notify],
  );
  const refresh = useCallback(async () => {
    const value = await call<LibrarySnapshot>('library.get');
    setSnapshot(value);
    const id = selectedRef.current;
    if (id) {
      try {
        setDetail(await call<LectureDetail>('lecture.get', { lectureId: id }));
      } catch {
        setDetail(null);
      }
    }
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setFatal(String(e)));
    let timer: number | undefined;
    const off = window.lecturedesk.on((event: AppEvent) => {
      if (event.type === 'partial' && event.lectureId)
        setPartial((p) => ({ ...p, [event.lectureId!]: { text: event.text || '', start: event.start } }));
      if (event.type === 'error') notify(event.message || 'Unknown error', 'error');
      if (event.type === 'recording-gap') {
        notify(event.message || translator(DEFAULT_SETTINGS.uiLanguage)('gap'), 'error');
        void capture.current?.stop().catch(() => {});
        capture.current = null;
        setRecordId(null);
        setLevel(0);
        void refresh().catch(() => {});
      }
      if (event.type === 'import-progress') setImportProgress((event.progress ?? 0) * 100);
      if (event.type === 'changed') {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          void refresh().catch((e) => notify(String(e), 'error'));
          setImportProgress(null);
        }, 180);
      }
    });
    const on = () => setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      off();
      window.clearTimeout(timer);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, [refresh, notify]);
  useEffect(() => {
    let cancelled = false;
    if (!selected) {
      setDetail(null);
      setPlayerUrl('');
      return;
    }
    void call<LectureDetail>('lecture.get', { lectureId: selected })
      .then((d) => {
        if (!cancelled) {
          setDetail(d);
          setVersionId(d.lecture.activeVersionId || d.versions[0]?.id || '');
          setCompareId('');
          setPlayerUrl('');
          setPlayerSegment('');
          setEditing(false);
          setSelectedText('');
        }
      })
      .catch((e) => notify(String(e), 'error'));
    return () => {
      cancelled = true;
    };
  }, [selected, notify]);
  useEffect(() => {
    const m = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      document.documentElement.dataset.theme =
        settings.theme === 'system' ? (m.matches ? 'dark' : 'light') : settings.theme;
      document.documentElement.lang = settings.uiLanguage;
    };
    update();
    m.addEventListener('change', update);
    return () => m.removeEventListener('change', update);
  }, [settings.theme, settings.uiLanguage]);
  useEffect(() => {
    const update = () => {
      if (recordId && !recordPaused)
        setElapsed(recordClock.current.elapsed + (Date.now() - recordClock.current.at) / 1000);
    };
    const id = window.setInterval(update, 500);
    return () => window.clearInterval(id);
  }, [recordId, recordPaused]);
  useEffect(() => {
    if (!query.trim()) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      setSearching(true);
      try {
        const hits = new Set<string>();
        const q = query.trim().toLocaleLowerCase();
        const lectures = snapshot?.lectures || [];
        for (let i = 0; i < lectures.length; i += 6) {
          const details = await Promise.all(
            lectures.slice(i, i + 6).map((l) => call<LectureDetail>('lecture.get', { lectureId: l.id })),
          );
          if (cancelled) return;
          details.forEach((d) => {
            const text = [
              d.lecture.title,
              d.lecture.topic,
              ...d.lecture.tags,
              ...d.segments.map((s) => s.text),
              ...(d.items || []).filter((item) => item.status === 'done').map((item) => item.text),
              ...d.versions.map((v) => v.content),
              ...d.materials.flatMap((m) => [m.name, ...m.pages.map((p) => p.text)]),
            ]
              .join('\n')
              .toLocaleLowerCase();
            if (text.includes(q)) hits.add(d.lecture.id);
          });
        }
        if (!cancelled) setSearchResults(hits);
      } catch (e) {
        if (!cancelled) notify(String(e), 'error');
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [query, searchFingerprint, notify]);
  const currentSubject = snapshot?.subjects.find((s) => s.id === scope);
  const currentVersion =
    detail?.versions.find((v) => v.id === versionId) ||
    detail?.versions.find((v) => v.id === detail.lecture.activeVersionId) ||
    detail?.versions[0];
  // Accepted text plus language-rejected items (shown only as warning rows, never as transcript).
  const units = useMemo(
    () => (detail ? transcriptUnits(detail.segments, detail.items || [], { includeRejected: true }) : []),
    [detail],
  );
  const sourceTranscript =
    detail?.versions.find((v) => v.kind === 'original')?.content || renderTranscript(units) || '';
  const visibleLectures = useMemo(() => {
    let list = (snapshot?.lectures || []).filter((l) =>
      scope === 'trash'
        ? !!l.deletedAt
        : !l.deletedAt &&
          (scope === 'all' || scope === 'unfiled' ? !l.subjectId || scope === 'all' : l.subjectId === scope),
    );
    if (query.trim()) {
      const q = query.toLocaleLowerCase();
      list = list.filter(
        (l) =>
          searchResults?.has(l.id) || [l.title, l.topic, ...l.tags].join(' ').toLocaleLowerCase().includes(q),
      );
    }
    if (tag) list = list.filter((l) => l.tags.includes(tag));
    return list.sort((a, b) =>
      sort === 'title'
        ? a.title.localeCompare(b.title)
        : sort === 'oldest'
          ? a.date.localeCompare(b.date)
          : b.date.localeCompare(a.date),
    );
  }, [snapshot, scope, query, searchResults, tag, sort]);
  const libraryMaterials = (snapshot?.materials || []).filter(
    (m) =>
      !m.lectureId &&
      scope !== 'trash' &&
      (scope === 'all' || scope === 'unfiled' ? !m.subjectId || scope === 'all' : m.subjectId === scope) &&
      (!query.trim() ||
        [m.name, ...m.pages.map((p) => p.text)]
          .join(' ')
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())),
  );
  const allTags = Array.from(new Set((snapshot?.lectures || []).flatMap((l) => l.tags))).sort();
  const tasks = (snapshot?.tasks || []).filter((task) => !['done', 'cancelled'].includes(task.status));
  const trashedLectures = (snapshot?.lectures || []).filter((l) => l.deletedAt);
  // Permanent deletion waits for capture and imports that still write into a trashed lecture.
  const trashBusy =
    trashedLectures.some(
      (l) => l.id === recordId || ['recording', 'paused', 'importing'].includes(l.status),
    ) ||
    (snapshot?.materials || []).some(
      (m) => m.status === 'processing' && trashedLectures.some((l) => l.id === m.lectureId),
    );
  async function clearTrash() {
    const trashed = new Set(trashedLectures.map((l) => l.id));
    if (selectedRef.current && trashed.has(selectedRef.current)) {
      // Release the audio file of a trashed lecture before its folder is deleted.
      playerRef.current?.pause();
      setPlayerUrl('');
    }
    setClearingTrash(true);
    const result = await perform(() => call<{ count: number }>('trash.empty'));
    setClearingTrash(false);
    if (!result) return;
    setClearTrashOpen(false);
    if (selectedRef.current && trashed.has(selectedRef.current)) {
      selectedRef.current = null;
      setSelected(null);
    }
    await refresh().catch((e) => notify(String(e), 'error'));
    notify(t('clearTrashDone').replace('{count}', String(result.count)));
  }
  /** Recording and import transcribe in the lecture language, so it must be chosen explicitly once. */
  function languageConfirmed(action: () => void) {
    if (!settings.setupComplete || settings.lectureLanguageConfirmed || languageChosen.current) return true;
    setLanguagePrompt(() => action);
    return false;
  }
  async function startRecording() {
    if (recordId || capture.current) return;
    if (!languageConfirmed(() => void startRecording())) return;
    setBusy(true);
    let id: string | undefined;
    const engine = new AudioCapture();
    capture.current = engine;
    try {
      await engine.prepare(settings.audioMode, settings.microphoneId);
      const lecture = await call<Lecture>('lecture.create', {
        subjectId: currentSubject?.id || null,
        // "География 14.10.26", or "География 14.10.26 (2)" when that name is already taken.
        title: autoLectureTitle(
          currentSubject?.name || t('autoLectureName'),
          new Date(),
          (snapshot?.lectures || []).filter((l) => !l.deletedAt).map((l) => l.title),
        ),
      });
      id = lecture.id;
      await call('record.start', { lectureId: id, mode: settings.audioMode });
      await engine.start(id, settings.audioMode, settings.microphoneId, setLevel, (error) => {
        notify(String(error), 'error');
      });
      recordClock.current = { elapsed: 0, at: Date.now() };
      setElapsed(0);
      setRecordPaused(false);
      setRecordId(id);
      setSelected(id);
      setPane('original');
      await refresh();
    } catch (e) {
      await engine.stop().catch(() => {});
      capture.current = null;
      if (id) {
        try {
          await call('record.stop', { lectureId: id });
        } catch {
          /* main preserves recoverable partial recording */
        }
      }
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  async function togglePause() {
    if (!recordId || !capture.current) return;
    setBusy(true);
    await perform(async () => {
      if (recordPaused) {
        await call('record.resume', { lectureId: recordId });
        await capture.current!.resume();
        recordClock.current.at = Date.now();
        setRecordPaused(false);
      } else {
        await capture.current!.pause();
        await call('record.pause', { lectureId: recordId });
        recordClock.current.elapsed = elapsed;
        setRecordPaused(true);
      }
      await refresh();
    });
    setBusy(false);
  }
  async function stopRecording() {
    if (!recordId) return;
    setBusy(true);
    const result = await perform(async () => {
      await capture.current?.stop();
      await call('record.stop', { lectureId: recordId });
      setRecordId(null);
      capture.current = null;
      setLevel(0);
      setPartial((p) => ({ ...p, [recordId]: { text: '' } }));
      await refresh();
      return true;
    }, t('stopped'));
    if (!result) setRecordPaused(true);
    setBusy(false);
  }
  async function importFiles(paths?: string[]) {
    if (!languageConfirmed(() => void importFiles(paths))) return;
    await perform(async () => {
      if (paths)
        await call('import.paths', {
          paths,
          lectureId: selected || undefined,
          subjectId: currentSubject?.id,
        });
      else await call('import.pick', { lectureId: selected || undefined, subjectId: currentSubject?.id });
      await refresh();
    });
  }
  async function playSegment(segmentId: string, offset = 0) {
    const result = await perform(() =>
      call<{ url: string }>('audio.url', { lectureId: detail?.lecture.id, segmentId }),
    );
    if (result) {
      pendingSeek.current = offset;
      setPlayerSegment(segmentId);
      setPlayerTime(offset);
      if (result.url === playerUrl && playerRef.current) {
        playerRef.current.currentTime = offset;
        void playerRef.current.play().catch((e) => notify(String(e), 'error'));
      } else setPlayerUrl(result.url);
    }
  }
  /** Plays the lecture audio from a lecture time, whichever saved file contains it. */
  function seekTo(seconds: number) {
    if (!detail) return;
    const target = segmentAt(detail.segments, seconds);
    if (!target) return;
    if (target.segment.id === playerSegment && playerRef.current) {
      setPlayerTime(target.offset);
      playerRef.current.currentTime = target.offset;
      if (playerRef.current.paused) void playerRef.current.play().catch((e) => notify(String(e), 'error'));
    } else void playSegment(target.segment.id, target.offset);
  }
  async function runAction(
    action: string,
    actionScope: string,
    text: string,
    language: Language,
    customActionId?: string,
  ) {
    if (!detail) return;
    await perform(async () => {
      await call('action.run', {
        lectureId: detail.lecture.id,
        versionId:
          actionScope === 'version'
            ? currentVersion?.id
            : actionScope === 'lecture'
              ? detail.versions.find((v) => v.kind === 'original')?.id
              : undefined,
        text: actionScope === 'selection' ? text : undefined,
        action,
        language,
        customActionId,
      });
      await refresh();
      setModal(null);
      setShowTasks(true);
    });
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (!settings.setupComplete || modal) {
        if (event.key.toLowerCase() === 'r') event.preventDefault();
        return;
      }
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        if (!recordId) void startRecording();
      }
      if (event.key === ',') {
        event.preventDefault();
        setModal('settings');
      }
      if (event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        setChatOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });
  const closeModal = useCallback(() => setModal(null), []);
  if (fatal)
    return (
      <div className="fatal-error">
        <Logo />
        <h2>{t('failed')}</h2>
        <p>{fatal}</p>
        <Button
          icon={RefreshCw}
          onClick={() => {
            setFatal('');
            void refresh().catch((e) => setFatal(String(e)));
          }}
        >
          {t('retry')}
        </Button>
      </div>
    );
  if (!snapshot)
    return (
      <div className="loading-screen">
        <Logo />
        <LoaderCircle size={28} className="spin" />
      </div>
    );
  return (
    <div
      className={`app ${chatOpen ? 'chat-open' : ''}`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrag(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDrag(false);
        const paths = Array.from(event.dataTransfer.files)
          .map((file) => window.lecturedesk.filePath(file))
          .filter(Boolean);
        if (paths.length) void importFiles(paths);
      }}
    >
      <aside className="sidebar">
        <div className={`sidebar-brand ${snapshot.platform === 'darwin' ? 'mac-titlebar' : ''}`}>
          <Logo />
        </div>
        <div className="workspace-label">
          <span className="workspace-avatar">L</span>
          <div>
            <strong>{t('library')}</strong>
            <small>{t('localPrivate')}</small>
          </div>
          <ShieldCheck size={15} />
        </div>
        <nav className="primary-nav">
          <button
            className={scope === 'all' ? 'selected' : ''}
            onClick={() => {
              setScope('all');
              setSelected(null);
            }}
          >
            <Library size={18} />
            {t('allLectures')}
            <span className="nav-count">{snapshot.lectures.filter((l) => !l.deletedAt).length}</span>
          </button>
          <button
            className={scope === 'unfiled' ? 'selected' : ''}
            onClick={() => {
              setScope('unfiled');
              setSelected(null);
            }}
          >
            <FolderOpen size={18} />
            {t('unfiled')}
          </button>
        </nav>
        <div className="sidebar-section">
          <span>{t('subjects')}</span>
          <IconButton
            icon={Plus}
            label={t('newSubject')}
            onClick={() => {
              setEditSubject(null);
              setModal('subject');
            }}
          />
        </div>
        <nav className="subject-nav">
          {snapshot.subjects.map((subject) => (
            <div className="subject-row" key={subject.id}>
              <button
                className={scope === subject.id ? 'selected' : ''}
                onClick={() => {
                  setScope(subject.id);
                  setSelected(null);
                }}
              >
                <span className="subject-dot" style={{ background: subject.color }} />
                {subject.name}
                <span className="nav-count">
                  {snapshot.lectures.filter((l) => l.subjectId === subject.id && !l.deletedAt).length}
                </span>
              </button>
              <IconButton
                icon={MoreHorizontal}
                label={t('more')}
                onClick={() => setSubjectMenu(subjectMenu === subject.id ? null : subject.id)}
              />
              {subjectMenu === subject.id && (
                <div className="context-menu subject-context">
                  <button
                    onClick={() => {
                      setEditSubject(subject);
                      setModal('subject');
                      setSubjectMenu(null);
                    }}
                  >
                    <Pencil size={14} />
                    {t('edit')}
                  </button>
                  <button
                    onClick={() => {
                      setDeleteSubject(subject);
                      setSubjectMenu(null);
                    }}
                  >
                    <Trash2 size={14} />
                    {t('delete')}
                  </button>
                </div>
              )}
            </div>
          ))}
          {!snapshot.subjects.length && (
            <button
              className="add-subject"
              onClick={() => {
                setEditSubject(null);
                setModal('subject');
              }}
            >
              <Plus size={16} />
              {t('newSubject')}
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={scope === 'trash' ? 'selected' : ''}
            onClick={() => {
              setScope('trash');
              setSelected(null);
            }}
          >
            <Trash2 size={17} />
            {t('trash')}
            <span className="nav-count">{snapshot.lectures.filter((l) => l.deletedAt).length || ''}</span>
          </button>
          <button onClick={() => setModal('settings')}>
            <SettingsIcon size={17} />
            {t('settings')}
          </button>
          <button onClick={() => setModal('shortcuts')}>
            <Keyboard size={17} />
            {t('help')}
          </button>
          <div className="local-status">
            <span className={`status-dot ${online ? '' : 'offline'}`} />
            <span>{online ? t('localLibrary') : t('offline')}</span>
          </div>
        </div>
      </aside>
      <main className="workspace">
        <header className="toolbar">
          <div className="breadcrumb">
            <span>{t('library')}</span>
            <ChevronRight size={14} />
            <strong>
              {currentSubject?.name ||
                t(scope === 'trash' ? 'trash' : scope === 'unfiled' ? 'unfiled' : 'allLectures')}
            </strong>
          </div>
          <div className="toolbar-actions">
            <Button icon={Upload} variant="ghost" onClick={() => void importFiles()}>
              {t('import')}
            </Button>
            <Button
              icon={Mic}
              variant="primary"
              busy={busy && !recordId}
              disabled={!!recordId}
              onClick={() => void startRecording()}
            >
              {t('record')}
            </Button>
            <IconButton
              icon={MessageSquare}
              label={t('chat')}
              className={chatOpen ? 'active' : ''}
              onClick={() => setChatOpen((v) => !v)}
            />
          </div>
        </header>
        {!online && (
          <div className="offline-banner">
            <WifiOff size={14} />
            {t('offline')}
          </div>
        )}
        {snapshot.recoverable
          .filter((l) => l.id !== recordId)
          .map((l) => (
            <div className="recovery-banner" key={l.id}>
              <AlertTriangle size={18} />
              <div>
                <strong>
                  {t('recoveryTitle')}: {l.title}
                </strong>
                <small>{t('recoveryBody')}</small>
              </div>
              <Button
                onClick={() =>
                  void perform(async () => {
                    await call('lecture.recover', { lectureId: l.id });
                    setSelected(l.id);
                    await refresh();
                  }, t('saved'))
                }
              >
                {t('recover')}
              </Button>
            </div>
          ))}
        {recordId && (
          <div className="recording-bar">
            <span className={`record-dot ${recordPaused ? 'paused' : ''}`} />
            <div className="record-title">
              <strong>{t(recordPaused ? 'paused' : 'recording')}</strong>
              <small>{snapshot.lectures.find((l) => l.id === recordId)?.title}</small>
            </div>
            <span className="record-timer">{time(elapsed)}</span>
            <div className="audio-level" aria-label={t('level')}>
              {Array.from({ length: 18 }, (_, i) => (
                <span key={i} className={level > i / 18 ? 'lit' : ''} />
              ))}
            </div>
            <div className="record-quick">
              <label title={t('liveTranslation')}>
                <input
                  type="checkbox"
                  checked={settings.liveTranslation}
                  onChange={(e) =>
                    void perform(() => call('settings.save', { liveTranslation: e.target.checked }))
                  }
                />
                <LanguagesIcon size={15} />
                {t('translation')}
              </label>
              <label title={t('liveAnalysis')}>
                <input
                  type="checkbox"
                  checked={settings.liveAnalysis}
                  onChange={(e) =>
                    void perform(() => call('settings.save', { liveAnalysis: e.target.checked }))
                  }
                />
                <Sparkles size={15} />
                {t('notes')}
              </label>
            </div>
            <Button icon={recordPaused ? Play : Pause} busy={busy} onClick={() => void togglePause()}>
              {t(recordPaused ? 'resume' : 'pause')}
            </Button>
            <Button icon={Square} variant="danger" disabled={busy} onClick={() => void stopRecording()}>
              {t('stop')}
            </Button>
          </div>
        )}
        <div className="library-heading">
          <div>
            <div className="library-title-row">
              <h1>
                {currentSubject?.name ||
                  t(scope === 'trash' ? 'trash' : scope === 'unfiled' ? 'unfiled' : 'allLectures')}
              </h1>
              {scope === 'trash' && trashedLectures.length > 0 && (
                <Button
                  variant="danger"
                  icon={Trash2}
                  disabled={trashBusy || clearingTrash}
                  title={trashBusy ? t('clearTrashBlocked') : undefined}
                  onClick={() => setClearTrashOpen(true)}
                >
                  {t('clearTrash')}
                </Button>
              )}
            </div>
            <p>
              {visibleLectures.length} {t('lectures')}
              {currentSubject?.glossary && (
                <span className="glossary-badge" title={currentSubject.glossary}>
                  <BookOpen size={12} />
                  {t('glossary')}
                </span>
              )}
            </p>
          </div>
          <div className="library-filters">
            <div className="search-field">
              <Search size={17} />
              <input
                ref={searchRef}
                aria-label={t('search')}
                placeholder={t('search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {searching ? (
                <LoaderCircle size={15} className="spin" />
              ) : query ? (
                <IconButton icon={X} label={t('close')} onClick={() => setQuery('')} />
              ) : (
                <kbd>⌘ K</kbd>
              )}
            </div>
            <Select aria-label={t('allTags')} value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">{t('allTags')}</option>
              {allTags.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </Select>
            <Select aria-label={t('newest')} value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="newest">{t('newest')}</option>
              <option value="oldest">{t('oldest')}</option>
              <option value="title">{t('titleSort')}</option>
            </Select>
          </div>
        </div>
        {visibleLectures.length > 0 && libraryMaterials.length > 0 && (
          <div className="library-materials-tray">
            <details>
              <summary>
                <FileText size={14} />
                {t('materials')} <span>{libraryMaterials.length}</span>
              </summary>
              <MaterialsView
                materials={libraryMaterials}
                t={t}
                perform={perform}
                onImport={() => void importFiles()}
              />
            </details>
          </div>
        )}
        <div
          className={`library-body ${!visibleLectures.length ? (libraryMaterials.length ? 'is-materials' : 'is-empty') : ''}`}
        >
          {!visibleLectures.length && libraryMaterials.length ? (
            <MaterialsView
              materials={libraryMaterials}
              t={t}
              perform={perform}
              onImport={() => void importFiles()}
            />
          ) : !visibleLectures.length ? (
            <Empty
              icon={query ? Search : scope === 'trash' ? Trash2 : BookOpen}
              title={t(
                query
                  ? 'emptySearch'
                  : scope === 'trash'
                    ? 'emptyTrash'
                    : currentSubject
                      ? 'emptySubject'
                      : 'emptyTitle',
              )}
              body={t(query ? 'emptySearchBody' : 'emptyBody')}
            >
              {scope !== 'trash' && !query && (
                <>
                  <Button
                    icon={Mic}
                    variant="primary"
                    disabled={!!recordId}
                    onClick={() => void startRecording()}
                  >
                    {t('startRecording')}
                  </Button>
                  <Button icon={Upload} onClick={() => void importFiles()}>
                    {t('addFiles')}
                  </Button>
                  <small className="empty-file-hint">{t('filesHint')}</small>
                </>
              )}
            </Empty>
          ) : (
            <>
              <section className="lecture-list" aria-label={t('lectures')}>
                {visibleLectures.map((lecture) => (
                  <button
                    className={`lecture-card ${selected === lecture.id ? 'selected' : ''}`}
                    key={lecture.id}
                    onClick={() => {
                      setSelected(lecture.id);
                      setPane('original');
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelected(lecture.id);
                      setModal('lecture');
                    }}
                  >
                    <div className="lecture-card-top">
                      <span className="lecture-file-icon">
                        <FileAudio size={19} />
                      </span>
                      <span className="lecture-card-date">
                        {dateLabel(lecture.date, settings.uiLanguage)}
                      </span>
                      {['recording', 'paused'].includes(lecture.status) && <span className="mini-record" />}
                    </div>
                    <strong>{lecture.title}</strong>
                    {lecture.topic && <p>{lecture.topic}</p>}
                    <div className="lecture-card-meta">
                      <Clock size={12} />
                      {time(lecture.duration)}
                      <span>·</span>
                      <span>
                        {snapshot.subjects.find((s) => s.id === lecture.subjectId)?.name || t('unfiled')}
                      </span>
                    </div>
                    {lecture.tags.length > 0 && (
                      <div className="tags">
                        {lecture.tags.slice(0, 3).map((v) => (
                          <span key={v}>{v}</span>
                        ))}
                      </div>
                    )}
                  </button>
                ))}
              </section>
              <section className="lecture-workspace">
                {!detail ? (
                  <Empty icon={BookOpen} title={t('chooseLecture')} body={t('chooseLectureBody')} compact />
                ) : (
                  <>
                    <header className="lecture-header">
                      <div className="lecture-eyebrow">
                        <span
                          className="subject-dot"
                          style={{
                            background:
                              snapshot.subjects.find((s) => s.id === detail.lecture.subjectId)?.color ||
                              '#87968f',
                          }}
                        />
                        {snapshot.subjects.find((s) => s.id === detail.lecture.subjectId)?.name ||
                          t('unfiled')}
                        <span>·</span>
                        {dateLabel(detail.lecture.date, settings.uiLanguage)}
                      </div>
                      <div className="lecture-title-row">
                        <h2>{detail.lecture.title}</h2>
                        <div className="lecture-header-buttons">
                          {detail.lecture.deletedAt ? (
                            <Button
                              icon={RefreshCw}
                              onClick={() =>
                                void perform(async () => {
                                  await call('lecture.restore', { lectureId: detail.lecture.id });
                                  await refresh();
                                }, t('saved'))
                              }
                            >
                              {t('restore')}
                            </Button>
                          ) : (
                            <>
                              <IconButton
                                icon={Download}
                                label={t('export')}
                                onClick={() => setModal('export')}
                              />
                              <div className="menu-anchor">
                                <IconButton
                                  icon={MoreHorizontal}
                                  label={t('more')}
                                  onClick={() => setLectureMenu((v) => !v)}
                                />
                                {lectureMenu && (
                                  <div className="context-menu">
                                    <button
                                      onClick={() => {
                                        setModal('lecture');
                                        setLectureMenu(false);
                                      }}
                                    >
                                      <Pencil size={14} />
                                      {t('edit')}
                                    </button>
                                    <button
                                      disabled={detail.lecture.id === recordId}
                                      onClick={() => {
                                        setLectureMenu(false);
                                        void perform(async () => {
                                          await call('lecture.trash', { lectureId: detail.lecture.id });
                                          setSelected(null);
                                          await refresh();
                                        });
                                      }}
                                    >
                                      <Trash2 size={14} />
                                      {t('moveToTrash')}
                                    </button>
                                    <button
                                      onClick={() => {
                                        setModal('improve');
                                        setLectureMenu(false);
                                      }}
                                    >
                                      <Sparkles size={14} />
                                      {t('improve')}
                                    </button>
                                  </div>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                      {detail.lecture.topic && <p className="lecture-topic">{detail.lecture.topic}</p>}
                      <div className="lecture-meta">
                        <Clock size={13} />
                        {time(detail.lecture.duration)}
                        <span>·</span>
                        <span>
                          {detail.segments.length} {t('audioSegments')}
                        </span>
                        {detail.lecture.tags.map((v) => (
                          <span className="tag" key={v}>
                            {v}
                          </span>
                        ))}
                      </div>
                    </header>
                    <nav className="lecture-tabs">
                      {(['original', 'versions', 'translation', 'notes', 'materials'] as Pane[]).map(
                        (tab) => (
                          <button
                            className={pane === tab ? 'active' : ''}
                            key={tab}
                            onClick={() => {
                              setPane(tab);
                              setEditing(false);
                            }}
                          >
                            {t(tab)}
                            {tab === 'versions' && detail.versions.length > 1 ? (
                              <span>{detail.versions.length}</span>
                            ) : tab === 'materials' && detail.materials.length ? (
                              <span>{detail.materials.length}</span>
                            ) : null}
                          </button>
                        ),
                      )}
                    </nav>
                    <div className="document-toolbar">
                      <div className="version-selector">
                        <FileText size={15} />
                        {pane === 'original' ? (
                          <span>{t('original')}</span>
                        ) : (
                          <Select
                            value={versionId}
                            aria-label={t('activeVersion')}
                            onChange={(e) => setVersionId(e.target.value)}
                          >
                            {detail.versions
                              .filter((v) =>
                                pane === 'translation'
                                  ? v.kind === 'translation'
                                  : pane === 'notes'
                                    ? v.kind === 'notes'
                                    : true,
                              )
                              .map((v) => (
                                <option key={v.id} value={v.id}>
                                  {v.title}
                                  {v.id === detail.lecture.activeVersionId ? ' ✓' : ''}
                                </option>
                              ))}
                          </Select>
                        )}
                      </div>
                      <div>
                        <Button
                          variant="ghost"
                          icon={Pencil}
                          onClick={() => {
                            setEditContent(
                              pane === 'original' ? sourceTranscript : currentVersion?.content || '',
                            );
                            setEditing(true);
                          }}
                          disabled={pane === 'materials'}
                        >
                          {t('edit')}
                        </Button>
                        <Button
                          variant="ghost"
                          icon={Sparkles}
                          onClick={() => setModal('actions')}
                          disabled={pane === 'materials'}
                        >
                          {t('quickActions')}
                        </Button>
                      </div>
                    </div>
                    <div
                      className="document-scroll"
                      onMouseUp={() => {
                        const selection = window.getSelection();
                        if (
                          selection?.anchorNode &&
                          document.querySelector('.document-scroll')?.contains(selection.anchorNode)
                        )
                          setSelectedText(selection.toString());
                      }}
                    >
                      {editing ? (
                        <div className="transcript-editor">
                          <Field label={t('editTranscript')} hint={t('noVersionsBody')}>
                            <textarea
                              autoFocus
                              rows={22}
                              value={editContent}
                              onChange={(e) => setEditContent(e.target.value)}
                            />
                          </Field>
                          <div className="row end">
                            <Button onClick={() => setEditing(false)}>{t('cancel')}</Button>
                            <Button
                              variant="primary"
                              icon={Check}
                              onClick={() =>
                                void perform(async () => {
                                  const version = await call<Version>('version.save', {
                                    lectureId: detail.lecture.id,
                                    kind: 'edited',
                                    title: t('editedTitle'),
                                    content: editContent,
                                    sourceVersionId: currentVersion?.id || null,
                                  });
                                  setVersionId(version.id);
                                  setEditing(false);
                                  setPane('versions');
                                  await refresh();
                                }, t('saved'))
                              }
                            >
                              {t('save')}
                            </Button>
                          </div>
                        </div>
                      ) : pane === 'materials' ? (
                        <MaterialsView
                          materials={detail.materials}
                          t={t}
                          perform={perform}
                          onImport={() => void importFiles()}
                        />
                      ) : pane === 'original' ? (
                        <>
                          {!sourceTranscript && !units.length ? (
                            <Empty
                              icon={Headphones}
                              title={t('noTranscript')}
                              body={t('noTranscriptBody')}
                              compact
                            />
                          ) : (
                            <div className="transcript document-body">
                              {units.length ? (
                                units.map((unit) =>
                                  unit.status === 'rejected' ? (
                                    <div className="transcript-segment rejected" key={unit.id}>
                                      <button
                                        className="timestamp"
                                        onClick={() => seekTo(unit.start)}
                                        title={t('segmentTiming')}
                                      >
                                        <Play size={11} />
                                        {time(unit.start)}
                                      </button>
                                      <div className="rejected-body">
                                        <p className="rejected-note">
                                          <AlertTriangle size={13} />
                                          {t('languageRejected')}
                                        </p>
                                        <details>
                                          <summary>{t('languageRejectedRaw')}</summary>
                                          <p>{unit.text}</p>
                                        </details>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="transcript-segment" key={unit.id}>
                                      <button
                                        className="timestamp"
                                        onClick={() => seekTo(unit.start)}
                                        title={t('segmentTiming')}
                                      >
                                        <Play size={11} />
                                        {time(unit.start)}
                                      </button>
                                      <p>{unit.text}</p>
                                    </div>
                                  ),
                                )
                              ) : (
                                <Markdown text={sourceTranscript} />
                              )}
                            </div>
                          )}
                          {partial[detail.lecture.id]?.text && (
                            <div className="partial-text">
                              <span className="live-label">
                                <LoaderCircle size={13} className="spin" />
                                {t('liveText')}
                                {partial[detail.lecture.id].start !== undefined &&
                                  ` · ${time(partial[detail.lecture.id].start!)}`}
                              </span>
                              <p>{partial[detail.lecture.id].text}</p>
                            </div>
                          )}
                          {detail.gaps.map((gap) => (
                            <div className="gap-notice" key={gap.id}>
                              <AlertTriangle size={14} />
                              <span>
                                {time(gap.at)} · {t('gap')}: {gap.reason}
                              </span>
                            </div>
                          ))}
                          {detail.segments.length > 0 && (
                            <p className="timing-note">
                              <Clock size={12} />
                              {t('segmentTiming')}
                            </p>
                          )}
                        </>
                      ) : pane === 'translation' ? (
                        <>
                          <div className="section-action">
                            <Languages
                              value={settings.outputLanguage}
                              t={t}
                              onChange={(v) => {
                                if (v !== 'auto')
                                  void perform(() => call('settings.save', { outputLanguage: v }));
                              }}
                            />
                            <Button
                              icon={LanguagesIcon}
                              onClick={() =>
                                void runAction('translate', 'lecture', '', settings.outputLanguage)
                              }
                            >
                              {t('translateAll')}
                            </Button>
                          </div>
                          {detail.versions.some((v) => v.kind === 'translation') ? (
                            <div className="comparison document-body">
                              <div>
                                <span className="column-label">{t('original')}</span>
                                <Markdown text={sourceTranscript} />
                              </div>
                              <div>
                                <span className="column-label">{t('translation')}</span>
                                <Markdown
                                  text={
                                    (
                                      detail.versions.find(
                                        (v) => v.id === versionId && v.kind === 'translation',
                                      ) || detail.versions.filter((v) => v.kind === 'translation').at(-1)
                                    )?.content || ''
                                  }
                                />
                              </div>
                            </div>
                          ) : (
                            <Empty
                              icon={LanguagesIcon}
                              title={t('noVersions')}
                              body={t('noVersionsBody')}
                              compact
                            />
                          )}
                        </>
                      ) : pane === 'notes' ? (
                        <>
                          <div className="section-action">
                            <span className="muted">{t('notes')}</span>
                            <Button
                              icon={Sparkles}
                              onClick={() =>
                                void runAction('analyze', 'lecture', '', settings.outputLanguage)
                              }
                            >
                              {t('updateNotes')}
                            </Button>
                          </div>
                          {detail.versions.some((v) => v.kind === 'notes') ? (
                            <div className="document-body">
                              <Markdown
                                text={
                                  (
                                    detail.versions.find((v) => v.id === versionId && v.kind === 'notes') ||
                                    detail.versions.filter((v) => v.kind === 'notes').at(-1)
                                  )?.content || ''
                                }
                              />
                            </div>
                          ) : (
                            <Empty icon={BookOpen} title={t('noVersions')} body={t('noVersionsBody')} compact>
                              <Button
                                icon={Sparkles}
                                onClick={() =>
                                  void runAction('notes', 'lecture', '', settings.outputLanguage)
                                }
                              >
                                {t('detailed_notes')}
                              </Button>
                            </Empty>
                          )}
                        </>
                      ) : currentVersion ? (
                        <>
                          <div className="version-metadata">
                            <div>
                              <span className="version-kind">{versionLabel(currentVersion.kind, t)}</span>
                              <span>{dateLabel(currentVersion.createdAt, settings.uiLanguage)}</span>
                              <span>{currentVersion.model || '—'}</span>
                            </div>
                            <div className="row">
                              <Button
                                variant="ghost"
                                icon={Check}
                                disabled={currentVersion.id === detail.lecture.activeVersionId}
                                onClick={() =>
                                  void perform(async () => {
                                    await call('version.activate', {
                                      lectureId: detail.lecture.id,
                                      versionId: currentVersion.id,
                                    });
                                    await refresh();
                                  })
                                }
                              >
                                {t(
                                  currentVersion.id === detail.lecture.activeVersionId
                                    ? 'activeVersion'
                                    : 'makeActive',
                                )}
                              </Button>
                              <Button
                                variant="ghost"
                                icon={MessageSquare}
                                onClick={() =>
                                  void perform(async () => {
                                    await call('version.activate', {
                                      lectureId: detail.lecture.id,
                                      versionId: currentVersion.id,
                                    });
                                    await refresh();
                                    setChatSeed(Date.now());
                                    setChatOpen(true);
                                  })
                                }
                              >
                                {t('openInChat')}
                              </Button>
                            </div>
                            {currentVersion.sourceVersionId && (
                              <small>
                                {t('source')}:{' '}
                                {detail.versions.find((v) => v.id === currentVersion.sourceVersionId)
                                  ?.title || currentVersion.sourceVersionId}
                              </small>
                            )}
                            <details>
                              <summary>{t('advanced')}</summary>
                              <pre>{JSON.stringify(currentVersion.parameters, null, 2)}</pre>
                            </details>
                            <Field label={t('compareWith')}>
                              <Select value={compareId} onChange={(e) => setCompareId(e.target.value)}>
                                <option value="">{t('compare')}</option>
                                {detail.versions
                                  .filter((v) => v.id !== currentVersion.id)
                                  .map((v) => (
                                    <option value={v.id} key={v.id}>
                                      {v.title}
                                    </option>
                                  ))}
                              </Select>
                            </Field>
                          </div>
                          {compareId ? (
                            <div className="comparison document-body">
                              <div>
                                <span className="column-label">
                                  {detail.versions.find((v) => v.id === compareId)?.title}
                                </span>
                                <Markdown
                                  text={detail.versions.find((v) => v.id === compareId)?.content || ''}
                                />
                              </div>
                              <div>
                                <span className="column-label">{currentVersion.title}</span>
                                <Markdown text={currentVersion.content} />
                              </div>
                            </div>
                          ) : (
                            <div className="document-body">
                              <Markdown text={currentVersion.content} />
                            </div>
                          )}
                        </>
                      ) : (
                        <Empty icon={FileText} title={t('noVersions')} body={t('noVersionsBody')} compact />
                      )}
                    </div>
                    {detail.segments.length > 0 && (
                      <div className="player-bar">
                        <IconButton
                          icon={playerPlaying ? Pause : Play}
                          label={t(playerPlaying ? 'pause' : 'resume')}
                          onClick={() => {
                            if (!playerUrl) {
                              void playSegment(detail.segments[0].id);
                              return;
                            }
                            if (playerRef.current?.paused)
                              void playerRef.current.play().catch((e) => notify(String(e), 'error'));
                            else playerRef.current?.pause();
                          }}
                        />
                        <span className="player-time">
                          {time(
                            (detail.segments.find((s) => s.id === playerSegment)?.start || 0) + playerTime,
                          )}
                        </span>
                        <input
                          aria-label={t('duration')}
                          type="range"
                          min={0}
                          max={Math.max(detail.lecture.duration, detail.segments.at(-1)?.end || 0, 1)}
                          step="0.1"
                          value={
                            (detail.segments.find((s) => s.id === playerSegment)?.start || 0) + playerTime
                          }
                          onChange={(e) => seekTo(Number(e.target.value))}
                        />
                        <span className="player-time">{time(detail.lecture.duration)}</span>
                        <Select
                          aria-label={t('playbackSpeed')}
                          value={playbackRate}
                          onChange={(e) => {
                            setPlaybackRate(e.target.value);
                            if (playerRef.current) playerRef.current.playbackRate = Number(e.target.value);
                          }}
                        >
                          {['0.75', '1', '1.25', '1.5', '2'].map((v) => (
                            <option value={v} key={v}>
                              {v}×
                            </option>
                          ))}
                        </Select>
                        <audio
                          ref={playerRef}
                          src={playerUrl || undefined}
                          onLoadedMetadata={(e) => {
                            e.currentTarget.currentTime = pendingSeek.current;
                            e.currentTarget.playbackRate = Number(playbackRate);
                            void e.currentTarget.play().catch((error) => notify(String(error), 'error'));
                          }}
                          onTimeUpdate={(e) => setPlayerTime(e.currentTarget.currentTime)}
                          onPlay={() => setPlayerPlaying(true)}
                          onPause={() => setPlayerPlaying(false)}
                          onError={() => notify(t('failed') + ': ' + t('originalAudio'), 'error')}
                          onEnded={() => {
                            const index = detail.segments.findIndex((s) => s.id === playerSegment);
                            if (index >= 0 && detail.segments[index + 1])
                              void playSegment(detail.segments[index + 1].id);
                            else setPlayerPlaying(false);
                          }}
                        />
                      </div>
                    )}
                  </>
                )}
              </section>
            </>
          )}
        </div>
        <footer className="statusbar">
          <button onClick={() => setShowTasks((v) => !v)}>
            {tasks.some((task) => task.status === 'running') ? (
              <LoaderCircle size={13} className="spin" />
            ) : tasks.some((task) => ['error', 'quota'].includes(task.status)) ? (
              <AlertTriangle size={13} />
            ) : (
              <CheckCircle2 size={13} />
            )}
            <span>{tasks.length ? `${tasks.length} · ${t('tasks')}` : t('noTasks')}</span>
            <ChevronDown size={12} />
          </button>
          {importProgress !== null && (
            <div className="import-progress">
              <Upload size={13} />
              <progress max={100} value={importProgress} />
              <span>{Math.round(importProgress)}%</span>
            </div>
          )}
          <button onClick={() => setModal('settings')}>
            <ShieldCheck size={13} />
            {snapshot.hasKey ? t('keyConnected') : t('keyMissing')}
          </button>
        </footer>
        {showTasks && (
          <div className="tasks-popover">
            <header>
              <strong>{t('tasks')}</strong>
              <IconButton icon={X} label={t('close')} onClick={() => setShowTasks(false)} />
            </header>
            {tasks.length ? (
              tasks.map((task) => (
                <div className="task-row" key={task.id}>
                  <div>
                    <strong>{taskLabel(task.kind, t)}</strong>
                    <small>{snapshot.lectures.find((l) => l.id === task.lectureId)?.title}</small>
                    <span className={`task-status ${task.status}`}>
                      {t(
                        task.status === 'queued'
                          ? 'pending'
                          : task.status === 'running'
                            ? 'running'
                            : task.status === 'quota'
                              ? 'quota'
                              : 'error',
                      )}
                    </span>
                    {task.error && <p>{task.error}</p>}
                  </div>
                  <div>
                    {['error', 'quota'].includes(task.status) && (
                      <IconButton
                        icon={RefreshCw}
                        label={t('retry')}
                        onClick={() => void perform(() => call('task.retry', { id: task.id }))}
                      />
                    )}
                    <IconButton
                      icon={X}
                      label={t('cancelTask')}
                      onClick={() => void perform(() => call('task.cancel', { id: task.id }))}
                    />
                  </div>
                </div>
              ))
            ) : (
              <p>{t('noTasks')}</p>
            )}
          </div>
        )}
      </main>
      {chatOpen && (
        <ChatPanel
          seed={chatSeed}
          snapshot={snapshot}
          detail={detail}
          selected={selected}
          currentSubject={currentSubject?.id || null}
          t={t}
          perform={perform}
          onClose={() => setChatOpen(false)}
          onLecture={(id) => setSelected(id)}
        />
      )}
      {!settings.setupComplete && (
        <Onboarding settings={settings} hasKey={snapshot.hasKey} t={t} perform={perform} onDone={refresh} />
      )}
      {languagePrompt && (
        <LectureLanguagePrompt
          settings={settings}
          t={t}
          onClose={() => setLanguagePrompt(null)}
          onConfirm={async (language) => {
            const next = languagePrompt;
            const saved = await perform(async () => {
              await call('settings.save', { lectureLanguage: language, lectureLanguageConfirmed: true });
              return true;
            });
            if (!saved) return;
            languageChosen.current = true;
            setLanguagePrompt(null);
            await refresh().catch((e) => notify(String(e), 'error'));
            next();
          }}
        />
      )}
      {modal === 'settings' && (
        <SettingsDialog
          settings={settings}
          snapshot={snapshot}
          t={t}
          perform={perform}
          onClose={closeModal}
          onSave={refresh}
        />
      )}
      {modal === 'subject' && (
        <SubjectDialog
          subject={editSubject}
          t={t}
          perform={perform}
          onClose={closeModal}
          onSave={async (subject) => {
            setScope(subject.id);
            await refresh();
          }}
        />
      )}
      {modal === 'lecture' && detail && (
        <LectureDialog
          lecture={detail.lecture}
          subjects={snapshot.subjects}
          t={t}
          perform={perform}
          onClose={closeModal}
          onSave={refresh}
        />
      )}
      {modal === 'export' && detail && (
        <ExportDialog detail={detail} versionId={versionId} t={t} perform={perform} onClose={closeModal} />
      )}
      {modal === 'actions' && detail && (
        <ActionsDialog
          t={t}
          settings={settings}
          custom={snapshot.actions}
          version={currentVersion}
          selectedText={selectedText}
          onRun={runAction}
          onClose={closeModal}
        />
      )}
      {modal === 'improve' && detail && (
        <Modal
          title={t('improveTitle')}
          onClose={closeModal}
          t={t}
          footer={
            <>
              <Button onClick={closeModal}>{t('cancel')}</Button>
              <Button
                variant="primary"
                icon={Sparkles}
                onClick={() =>
                  void perform(async () => {
                    await call('transcript.improve', { lectureId: detail.lecture.id });
                    closeModal();
                    await refresh();
                    setShowTasks(true);
                  })
                }
              >
                {t('runImprove')}
              </Button>
            </>
          }
        >
          <div className="notice-box">
            <AlertTriangle size={21} />
            <p>{t('improveBody')}</p>
          </div>
        </Modal>
      )}
      {deleteSubject && (
        <Modal
          title={t('deleteSubjectTitle')}
          t={t}
          onClose={() => setDeleteSubject(null)}
          footer={
            <>
              <Button onClick={() => setDeleteSubject(null)}>{t('cancel')}</Button>
              <Button
                variant="danger"
                onClick={() =>
                  void perform(async () => {
                    await call('subject.delete', { id: deleteSubject.id });
                    setDeleteSubject(null);
                    setScope('all');
                    await refresh();
                  })
                }
              >
                {t('confirmDelete')}
              </Button>
            </>
          }
        >
          <p>{t('deleteSubjectBody')}</p>
        </Modal>
      )}
      {clearTrashOpen && (
        <Modal
          title={t('clearTrashConfirmTitle')}
          t={t}
          onClose={() => {
            if (!clearingTrash) setClearTrashOpen(false);
          }}
          footer={
            <>
              <Button disabled={clearingTrash} onClick={() => setClearTrashOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                icon={Trash2}
                busy={clearingTrash}
                disabled={trashBusy || !trashedLectures.length}
                onClick={() => void clearTrash()}
              >
                {t('clearTrashConfirm')}
              </Button>
            </>
          }
        >
          <div className="notice-box danger" role="alert">
            <AlertTriangle size={21} />
            <p>{t('clearTrashConfirmBody').replace('{count}', String(trashedLectures.length))}</p>
          </div>
          {trashBusy && <p className="muted">{t('clearTrashBlocked')}</p>}
        </Modal>
      )}
      {modal === 'shortcuts' && (
        <Modal title={t('shortcuts')} onClose={closeModal} t={t}>
          {(
            [
              'recordShortcut',
              'searchShortcut',
              'chatShortcut',
              'settingsShortcut',
              'escapeShortcut',
            ] as TextKey[]
          ).map((key, i) => (
            <div className="shortcut-row" key={key}>
              <span>{t(key)}</span>
              <kbd>{['⌘ / Ctrl + R', '⌘ / Ctrl + K', '⌘ / Ctrl + Shift + C', '⌘ / Ctrl + ,', 'Esc'][i]}</kbd>
            </div>
          ))}
          <p className="muted">
            LectureDesk {snapshot.appVersion} · {snapshot.platform}
          </p>
        </Modal>
      )}
      {drag && (
        <div className="drop-overlay">
          <Upload size={44} />
          <h2>{t('dropHint')}</h2>
          <p>{t('filesHint')}</p>
        </div>
      )}
      <div className="toast-stack" aria-live="polite">
        {notices.map((notice) => (
          <div className={`toast ${notice.type}`} key={notice.id}>
            {notice.type === 'error' ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
            <p>{notice.text}</p>
            <IconButton
              icon={X}
              label={t('dismiss')}
              onClick={() => setNotices((n) => n.filter((x) => x.id !== notice.id))}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function SubjectDialog({
  subject,
  t,
  perform,
  onClose,
  onSave,
}: {
  subject: Subject | null;
  t: T;
  perform: Perform;
  onClose: () => void;
  onSave: (subject: Subject) => Promise<void>;
}) {
  const [name, setName] = useState(subject?.name || '');
  const [glossary, setGlossary] = useState(subject?.glossary || '');
  const [color, setColor] = useState(subject?.color || '#52917b');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={t(subject ? 'edit' : 'newSubject')}
      onClose={onClose}
      t={t}
      footer={
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!name.trim()}
            onClick={() => {
              setBusy(true);
              void perform(async () => {
                const result = await call<Subject>('subject.save', {
                  id: subject?.id,
                  name: name.trim(),
                  color,
                  glossary,
                });
                await onSave(result);
                onClose();
              }, t('saved')).finally(() => setBusy(false));
            }}
          >
            {t('save')}
          </Button>
        </>
      }
    >
      <Field label={t('subjectName')}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={160} />
      </Field>
      <Field label={t('subjectColor')}>
        <div className="color-picker">
          {['#52917b', '#7391c7', '#bc8ba7', '#c49f66', '#9b8fc4', '#cf847d'].map((value) => (
            <button
              key={value}
              aria-label={value}
              className={color === value ? 'active' : ''}
              style={{ background: value }}
              onClick={() => setColor(value)}
            >
              {color === value && <Check size={16} />}
            </button>
          ))}
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            aria-label={t('subjectColor')}
          />
        </div>
      </Field>
      <Field label={t('glossary')} hint={t('glossaryHint')}>
        <textarea rows={5} value={glossary} onChange={(e) => setGlossary(e.target.value)} />
      </Field>
    </Modal>
  );
}
function LectureDialog({
  lecture,
  subjects,
  t,
  perform,
  onClose,
  onSave,
}: {
  lecture: Lecture;
  subjects: Subject[];
  t: T;
  perform: Perform;
  onClose: () => void;
  onSave: () => Promise<void>;
}) {
  const [title, setTitle] = useState(lecture.title);
  const [topic, setTopic] = useState(lecture.topic);
  const [date, setDate] = useState(lecture.date.slice(0, 10));
  const [tags, setTags] = useState(lecture.tags.join(', '));
  const [subjectId, setSubject] = useState(lecture.subjectId || '');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={t('edit')}
      onClose={onClose}
      t={t}
      footer={
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!title.trim() || !date}
            onClick={() => {
              setBusy(true);
              void perform(async () => {
                await call('lecture.save', {
                  id: lecture.id,
                  title: title.trim(),
                  topic,
                  date,
                  tags: tags
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean),
                  subjectId: subjectId || null,
                });
                await onSave();
                onClose();
              }, t('saved')).finally(() => setBusy(false));
            }}
          >
            {t('save')}
          </Button>
        </>
      }
    >
      <Field label={t('lecture')}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
      </Field>
      <Field label={t('topic')}>
        <input value={topic} onChange={(e) => setTopic(e.target.value)} />
      </Field>
      <div className="form-grid">
        <Field label={t('date')}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label={t('subject')}>
          <Select value={subjectId} onChange={(e) => setSubject(e.target.value)}>
            <option value="">{t('unfiled')}</option>
            {subjects.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={t('tags')} hint=",">
        <input value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>
    </Modal>
  );
}
function AudioControls({
  settings,
  onChange,
  t,
  perform,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  t: T;
  perform: Perform;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);
  const stop = useRef<(() => Promise<void>) | null>(null);
  const audio = useRef<AudioCapture | null>(null);
  const [support, setSupport] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    audio.current = new AudioCapture();
    void audio.current
      .devices()
      .then(setDevices)
      .catch(() => {});
    void call<Record<string, unknown>>('audio.sources')
      .then(setSupport)
      .catch(() => {});
    return () => {
      void audio.current?.stop().catch(() => {});
    };
  }, []);
  async function test() {
    setBusy(true);
    await perform(async () => {
      if (testing) {
        await stop.current?.();
        stop.current = null;
        setTesting(false);
        setLevel(0);
      } else {
        stop.current = await audio.current!.test(
          settings.audioMode,
          settings.microphoneId,
          setLevel,
          (message) => {
            setTesting(false);
            setLevel(0);
            void audio.current?.stop().catch(() => {});
            void perform(async () => {
              throw new Error(message);
            });
          },
        );
        setTesting(true);
        setDevices(await audio.current!.devices());
      }
    });
    setBusy(false);
  }
  return (
    <>
      <Field label={t('audioSource')}>
        <div className="source-choices">
          {(
            [
              { id: 'microphone', label: 'microphone', icon: Mic },
              { id: 'system', label: 'systemAudio', icon: Headphones },
              { id: 'both', label: 'bothAudio', icon: GripVertical },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              disabled={testing}
              className={settings.audioMode === id ? 'active' : ''}
              onClick={() => onChange({ audioMode: id })}
            >
              <Icon size={20} />
              <span>{t(label)}</span>
              {settings.audioMode === id && <Check size={14} />}
            </button>
          ))}
        </div>
      </Field>
      {settings.audioMode !== 'system' && (
        <Field label={t('device')}>
          <Select
            value={settings.microphoneId}
            disabled={testing}
            onChange={(e) => onChange({ microphoneId: e.target.value })}
          >
            <option value="">{t('defaultDevice')}</option>
            {devices
              .filter((d) => d.kind === 'audioinput')
              .map((device, i) => (
                <option value={device.deviceId} key={device.deviceId}>
                  {device.label || `${t('microphone')} ${i + 1}`}
                </option>
              ))}
          </Select>
        </Field>
      )}
      {settings.audioMode === 'both' && (
        <div className="notice-box">
          <AlertTriangle size={17} />
          <p>{t('bothWarning')}</p>
        </div>
      )}
      <div className="audio-test">
        <Button icon={testing ? Square : Mic} busy={busy} onClick={() => void test()}>
          {t(testing ? 'stopTest' : 'audioTest')}
        </Button>
        <div
          className="level-meter"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
          aria-label={t('level')}
        >
          <span style={{ width: `${Math.min(level * 100, 100)}%` }} />
        </div>
        <span>{Math.round(level * 100)}%</span>
      </div>
      {support && typeof support.systemAudio === 'string' && (
        <p className="muted small">
          {t(support.platform === 'darwin' ? 'macSystemAudioHint' : 'windowsSystemAudioHint')}
        </p>
      )}
      {support && typeof support.note === 'string' && <p className="muted small">{support.note}</p>}
      {support && typeof support.message === 'string' && <p className="muted small">{support.message}</p>}
    </>
  );
}
function ApiControls({
  settings,
  onChange,
  hasKey,
  t,
  perform,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  hasKey: boolean;
  t: T;
  perform: Perform;
}) {
  const [key, setKey] = useState('');
  const [connected, setConnected] = useState(hasKey);
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<Catalog>({ ...MODEL_CATALOG, available: [], verified: false });
  const load = () =>
    perform(async () => {
      const value = await call<Catalog>('models.list');
      setCatalog(value);
    });
  async function validate() {
    setBusy(true);
    await perform(async () => {
      const result = await call<{ valid: boolean; models: string[] }>('key.validate', { key: key.trim() });
      if (!result.valid) throw new Error(t('failed') + ': ' + t('apiKey'));
      await call('key.set', { key: key.trim() });
      setKey('');
      setConnected(true);
      await load();
    }, t('keyValid'));
    setBusy(false);
  }
  useEffect(() => {
    if (hasKey) void load();
  }, []);
  const fields: {
    key: 'liveModel' | 'fileModel' | 'translationModel' | 'analysisModel' | 'chatModel';
    group: 'live' | 'file' | 'text';
  }[] = [
    { key: 'liveModel', group: 'live' },
    { key: 'fileModel', group: 'file' },
    { key: 'translationModel', group: 'text' },
    { key: 'analysisModel', group: 'text' },
    { key: 'chatModel', group: 'text' },
  ];
  return (
    <>
      <div className={`key-status ${connected ? 'connected' : ''}`}>
        <KeyRound size={18} />
        <span>{t(connected ? 'keyConnected' : 'keyMissing')}</span>
        {connected && (
          <Button
            variant="ghost"
            icon={Trash2}
            onClick={() =>
              void perform(async () => {
                await call('key.delete');
                setConnected(false);
                setKey('');
              })
            }
          >
            {t('removeKey')}
          </Button>
        )}
      </div>
      <Field label={t('apiKey')} hint={t('apiKeyHint')}>
        <div className="key-input">
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-…"
            autoComplete="off"
            spellCheck={false}
          />
          <Button busy={busy} disabled={!key.trim()} onClick={() => void validate()}>
            {t('validateKey')}
          </Button>
        </div>
      </Field>
      <p className="privacy-text">
        <ShieldCheck size={16} />
        {t('privacy')}
      </p>
      <Field label={t('quality')}>
        <div className="segmented">
          <button
            className={settings.quality === 'balanced' ? 'active' : ''}
            onClick={() => onChange({ quality: 'balanced' })}
          >
            {t('balanced')}
          </button>
          <button
            className={settings.quality === 'maximum' ? 'active' : ''}
            onClick={() =>
              onChange({
                quality: 'maximum',
                liveModel: catalog.live[0] || settings.liveModel,
                fileModel: catalog.file[0] || settings.fileModel,
                translationModel: catalog.text[0] || settings.translationModel,
                analysisModel: catalog.text[0] || settings.analysisModel,
                chatModel: catalog.text[0] || settings.chatModel,
              })
            }
          >
            <Sparkles size={14} />
            {t('maximum')}
          </button>
        </div>
      </Field>
      <details className="advanced-models">
        <summary>
          {t('models')}
          <SlidersHorizontal size={15} />
        </summary>
        <p className="muted small">{t('modelHint')}</p>
        <div className="form-grid">
          {fields.map(({ key: field, group }) => (
            <Field
              key={field}
              label={t(field)}
              hint={
                field === 'liveModel'
                  ? t(turnPolicy(settings.liveModel) === 'server' ? 'liveModeServer' : 'liveModeLocal')
                  : undefined
              }
            >
              <Select value={settings[field]} onChange={(e) => onChange({ [field]: e.target.value })}>
                {Array.from(new Set([settings[field], ...catalog[group]])).map((model) => (
                  <option key={model} value={model}>
                    {model}
                    {catalog.verified && !catalog.available.includes(model) ? ` · ${t('unavailable')}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </div>
        <Button variant="ghost" icon={RefreshCw} onClick={() => void load()}>
          {t('refreshModels')}
        </Button>
      </details>
    </>
  );
}
function FolderControls({
  settings,
  onChange,
  t,
  perform,
  backup = true,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  t: T;
  perform: Perform;
  backup?: boolean;
}) {
  const choose = (key: 'storageFolder' | 'backupFolder') =>
    void perform(async () => {
      const path = await call<string | null>('folder.choose');
      if (path) onChange({ [key]: path });
    });
  return (
    <>
      <Field label={t('storageFolder')} hint={t('storageHint')}>
        <div className="folder-input">
          <HardDrive size={17} />
          <input readOnly value={settings.storageFolder} placeholder={t('defaultFolder')} />
          <Button onClick={() => choose('storageFolder')}>{t('chooseFolder')}</Button>
        </div>
      </Field>
      {backup && (
        <>
          <Field label={t('backupFolder')} hint={t('backupHint')}>
            <div className="folder-input">
              <Cloud size={17} />
              <input readOnly value={settings.backupFolder} placeholder="iCloud Drive / Google Drive" />
              <Button onClick={() => choose('backupFolder')}>{t('chooseFolder')}</Button>
              {settings.backupFolder && (
                <IconButton icon={X} label={t('close')} onClick={() => onChange({ backupFolder: '' })} />
              )}
            </div>
          </Field>
          <Toggle
            checked={settings.backupAudio}
            label={t('backupAudio')}
            onChange={(value) => onChange({ backupAudio: value })}
          />
          <div className="form-grid">
            <Field label={t('backupInterval')} hint={t('backupDisabled')}>
              <input
                type="number"
                min={0}
                max={8760}
                value={settings.backupHours}
                onChange={(e) => onChange({ backupHours: Math.max(0, Number(e.target.value)) })}
              />
            </Field>
            <Field label={t('backupRetention')}>
              <input
                type="number"
                min={1}
                max={100}
                value={settings.backupRetention}
                onChange={(e) => onChange({ backupRetention: Math.max(1, Number(e.target.value)) })}
              />
            </Field>
          </div>
        </>
      )}
    </>
  );
}
function Onboarding({
  settings,
  hasKey,
  perform,
  onDone,
}: {
  settings: Settings;
  hasKey: boolean;
  t: T;
  perform: Perform;
  onDone: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const t = translator(draft.uiLanguage);
  const update = (patch: Partial<Settings>) => setDraft((d) => ({ ...d, ...patch }));
  const labels: TextKey[] = ['setupLanguages', 'setupKey', 'setupAudio', 'setupStorage', 'setupSubject'];
  async function finish() {
    setBusy(true);
    await perform(async () => {
      await call('settings.save', { ...draft, setupComplete: true, lectureLanguageConfirmed: true });
      if (name.trim()) await call('subject.save', { name: name.trim(), color: '#52917b', glossary: '' });
      await onDone();
    });
    setBusy(false);
  }
  return (
    <div className="onboarding-backdrop">
      <div className="onboarding" role="dialog" aria-modal="true" aria-label={t('welcome')}>
        <aside className="onboarding-aside">
          <Logo />
          <div className="setup-intro">
            <span className="eyebrow">{t('setup')}</span>
            <h1>{t('welcomeBody')}</h1>
            <p>{t('privacy')}</p>
          </div>
          <ol className="setup-steps">
            {labels.map((label, i) => (
              <li className={i === step ? 'active' : i < step ? 'complete' : ''} key={label}>
                <span>{i < step ? <Check size={14} /> : i + 1}</span>
                {t(label)}
              </li>
            ))}
          </ol>
          <span className="onboarding-local">
            <ShieldCheck size={16} />
            {t('localPrivate')}
          </span>
        </aside>
        <section className="onboarding-main">
          <div className="setup-count">{step + 1} / 5</div>
          <h2>{t(labels[step])}</h2>
          <div className="setup-content">
            {step === 0 ? (
              <>
                <p className="muted">{t('welcome')}</p>
                <Field label={t('interfaceLanguage')}>
                  <Languages
                    value={draft.uiLanguage}
                    t={t}
                    onChange={(v) => v !== 'auto' && update({ uiLanguage: v })}
                  />
                </Field>
                <Field label={t('lectureLanguage')} hint={t('lectureLanguageHint')}>
                  <Languages
                    value={draft.lectureLanguage}
                    t={t}
                    onChange={(v) => v !== 'auto' && update({ lectureLanguage: v })}
                  />
                </Field>
                <Field label={t('targetLanguage')}>
                  <Languages
                    value={draft.outputLanguage}
                    t={t}
                    onChange={(v) => v !== 'auto' && update({ outputLanguage: v })}
                  />
                </Field>{' '}
              </>
            ) : step === 1 ? (
              <>
                <ApiControls settings={draft} onChange={update} hasKey={hasKey} t={t} perform={perform} />
                <p className="muted small">{t('noKeyContinue')}</p>
              </>
            ) : step === 2 ? (
              <AudioControls settings={draft} onChange={update} t={t} perform={perform} />
            ) : step === 3 ? (
              <FolderControls settings={draft} onChange={update} t={t} perform={perform} />
            ) : (
              <>
                <div className="setup-subject-icon">
                  <Folder size={36} />
                </div>
                <p className="muted">{t('emptySubject')}</p>
                <Field label={t('subjectName')}>
                  <input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={160} />
                </Field>
                <p className="privacy-text">
                  <ShieldCheck size={17} />
                  {t('localLibrary')}
                </p>
              </>
            )}
          </div>
          <footer>
            <Button
              icon={ArrowLeft}
              variant="ghost"
              disabled={step === 0 || busy}
              onClick={() => setStep((s) => s - 1)}
            >
              {t('back')}
            </Button>
            {step === 4 ? (
              <Button variant="primary" icon={ArrowUpRight} busy={busy} onClick={() => void finish()}>
                {t('finish')}
              </Button>
            ) : (
              <Button variant="primary" icon={ChevronRight} onClick={() => setStep((s) => s + 1)}>
                {t('next')}
              </Button>
            )}
          </footer>
        </section>
      </div>
    </div>
  );
}
/** One-time choice before the first recording/import after 'auto' detection was removed. */
function LectureLanguagePrompt({
  settings,
  t,
  onClose,
  onConfirm,
}: {
  settings: Settings;
  t: T;
  onClose: () => void;
  onConfirm: (language: Language) => Promise<void>;
}) {
  const [language, setLanguage] = useState<Language>(settings.lectureLanguage);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={t('lectureLanguagePromptTitle')}
      onClose={onClose}
      t={t}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            icon={Check}
            busy={busy}
            onClick={() => {
              setBusy(true);
              void onConfirm(language).finally(() => setBusy(false));
            }}
          >
            {t('confirmLanguage')}
          </Button>
        </>
      }
    >
      <p className="muted">{t('lectureLanguagePromptBody')}</p>
      <Field label={t('lectureLanguage')}>
        <Languages value={language} t={t} onChange={(v) => v !== 'auto' && setLanguage(v)} />
      </Field>
    </Modal>
  );
}
function LiveSettings({
  settings,
  onChange,
  t,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  t: T;
}) {
  return (
    <>
      <Toggle
        checked={settings.liveTranscription}
        label={t('liveTranscription')}
        onChange={(value) => onChange({ liveTranscription: value })}
      />
      <Toggle
        checked={settings.liveTranslation}
        label={t('liveTranslation')}
        onChange={(value) => onChange({ liveTranslation: value })}
      />
      <Toggle
        checked={settings.liveAnalysis}
        label={t('liveAnalysis')}
        onChange={(value) => onChange({ liveAnalysis: value })}
      />
      <Toggle
        checked={settings.finalNotes}
        label={t('finalNotes')}
        onChange={(value) => onChange({ finalNotes: value })}
      />
      <div className="form-grid">
        <Field label={t('translationWords')}>
          <input
            type="number"
            min={1}
            max={10000}
            list="translation-thresholds"
            value={settings.translationWords}
            onChange={(e) => onChange({ translationWords: Math.max(1, Number(e.target.value)) })}
          />
          <datalist id="translation-thresholds">
            {[20, 50, 100].map((v) => (
              <option value={v} key={v} />
            ))}
          </datalist>
        </Field>
        <Field label={t('translationWait')}>
          <input
            type="number"
            min={5}
            max={300}
            value={settings.translationWaitSeconds}
            onChange={(e) =>
              onChange({ translationWaitSeconds: Math.max(5, Math.min(300, Number(e.target.value))) })
            }
          />
        </Field>
        <Field label={t('analysisWords')}>
          <input
            type="number"
            min={1}
            max={20000}
            list="analysis-thresholds"
            value={settings.analysisWords}
            onChange={(e) => onChange({ analysisWords: Math.max(1, Number(e.target.value)) })}
          />
          <datalist id="analysis-thresholds">
            {[200, 500, 1000].map((v) => (
              <option value={v} key={v} />
            ))}
          </datalist>
        </Field>
        <Field label={t('analysisInterval')}>
          <input
            type="number"
            min={10}
            max={3600}
            value={settings.analysisIntervalSeconds}
            onChange={(e) => onChange({ analysisIntervalSeconds: Math.max(10, Number(e.target.value)) })}
          />
        </Field>
      </div>
    </>
  );
}
function SettingsDialog({
  settings,
  snapshot,
  perform,
  onClose,
  onSave,
}: {
  settings: Settings;
  snapshot: LibrarySnapshot;
  t: T;
  perform: Perform;
  onClose: () => void;
  onSave: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [section, setSection] = useState('general');
  const [busy, setBusy] = useState(false);
  const [translationChange, setTranslationChange] = useState<Language | null>(null);
  const t = translator(draft.uiLanguage);
  const update = (patch: Partial<Settings>) => setDraft((d) => ({ ...d, ...patch }));
  async function save() {
    setBusy(true);
    await perform(async () => {
      if (
        draft.outputLanguage !== settings.outputLanguage &&
        settings.liveTranslation &&
        snapshot.lectures.some((l) => l.status === 'recording' || l.status === 'paused')
      ) {
        setTranslationChange(draft.outputLanguage);
        return;
      }
      // Saving settings confirms the lecture language shown in them.
      await call('settings.save', { ...draft, lectureLanguageConfirmed: true });
      await onSave();
      onClose();
    }, t('saved'));
    setBusy(false);
  }
  const sections = [
    { id: 'general', label: 'general', icon: SettingsIcon },
    { id: 'audio', label: 'audio', icon: Mic },
    { id: 'ai', label: 'ai', icon: KeyRound },
    { id: 'storage', label: 'storage', icon: HardDrive },
    { id: 'actions', label: 'actions', icon: Sparkles },
  ] as const;
  return (
    <Modal
      title={t('settings')}
      onClose={onClose}
      t={t}
      wide
      footer={
        <>
          <span className="footer-version">LectureDesk {snapshot.appVersion}</span>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" icon={Check} busy={busy} onClick={() => void save()}>
            {t('save')}
          </Button>
        </>
      }
    >
      <div className="settings-layout">
        <nav className="settings-nav">
          {sections.map(({ id, label, icon: Icon }) => (
            <button key={id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}>
              <Icon size={17} />
              {t(label)}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {section === 'general' ? (
            <>
              <h3>{t('general')}</h3>
              <Field label={t('interfaceLanguage')}>
                <Languages
                  value={draft.uiLanguage}
                  t={t}
                  onChange={(v) => v !== 'auto' && update({ uiLanguage: v })}
                />
              </Field>
              <Field label={t('lectureLanguage')} hint={t('lectureLanguageHint')}>
                <Languages
                  value={draft.lectureLanguage}
                  t={t}
                  onChange={(v) => v !== 'auto' && update({ lectureLanguage: v })}
                />
              </Field>
              <Field label={t('targetLanguage')}>
                <Languages
                  value={draft.outputLanguage}
                  t={t}
                  onChange={(v) => v !== 'auto' && update({ outputLanguage: v })}
                />
              </Field>
              <Field label={t('appearance')}>
                <div className="segmented">
                  {(['light', 'dark', 'system'] as const).map((theme) => (
                    <button
                      key={theme}
                      className={draft.theme === theme ? 'active' : ''}
                      onClick={() => update({ theme })}
                    >
                      {t(theme === 'system' ? 'systemTheme' : theme)}
                    </button>
                  ))}
                </div>
              </Field>
              <p className="privacy-text">
                <ShieldCheck size={18} />
                {t('privacy')}
              </p>
            </>
          ) : section === 'audio' ? (
            <>
              <h3>{t('audio')}</h3>
              <AudioControls settings={draft} onChange={update} t={t} perform={perform} />
              <div className="settings-divider" />
              <LiveSettings settings={draft} onChange={update} t={t} />
            </>
          ) : section === 'ai' ? (
            <>
              <h3>{t('ai')}</h3>
              <ApiControls
                settings={draft}
                onChange={update}
                hasKey={snapshot.hasKey}
                t={t}
                perform={perform}
              />
              <UsageView
                lectureIds={snapshot.lectures.filter((l) => !l.deletedAt).map((l) => l.id)}
                t={t}
                perform={perform}
              />
            </>
          ) : section === 'storage' ? (
            <>
              <h3>{t('storage')}</h3>
              <FolderControls settings={draft} onChange={update} t={t} perform={perform} />
              <BackupControls settings={draft} t={t} perform={perform} />
            </>
          ) : (
            <CustomActionsEditor
              actions={snapshot.actions}
              settings={draft}
              t={t}
              perform={perform}
              onRefresh={onSave}
            />
          )}
        </div>
      </div>
      {translationChange && (
        <div className="translation-choice">
          <div>
            <h3>{t('changeLanguageTitle')}</h3>
            <p>{t('changeLanguageBody')}</p>
          </div>
          <div className="row">
            <Button onClick={() => setTranslationChange(null)}>{t('cancel')}</Button>
            {[false, true].map((whole) => (
              <Button
                key={String(whole)}
                variant={whole ? 'primary' : 'secondary'}
                onClick={() =>
                  void perform(async () => {
                    await call('settings.save', draft);
                    if (whole)
                      for (const lecture of snapshot.lectures.filter(
                        (l) => l.status === 'recording' || l.status === 'paused',
                      ))
                        await call('action.run', {
                          lectureId: lecture.id,
                          action: 'translate',
                          language: translationChange,
                        });
                    setTranslationChange(null);
                    await onSave();
                    onClose();
                  }, t('saved'))
                }
              >
                {t(whole ? 'wholeTranslation' : 'futureTranslation')}
              </Button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

function BackupControls({ settings, t, perform }: { settings: Settings; t: T; perform: Perform }) {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ path: string; data: Record<string, unknown> } | null>(null);
  const load = useCallback(
    () =>
      perform(async () => {
        setBackups(await call<Backup[]>('backup.list', { folder: settings.backupFolder }));
      }),
    [settings.backupFolder, perform],
  );
  useEffect(() => {
    if (settings.backupFolder) void load();
    else setBackups([]);
  }, [load, settings.backupFolder]);
  return (
    <div className="backup-controls">
      <div className="section-action">
        <h3>{t('backupHistory')}</h3>
        <Button
          icon={Cloud}
          busy={busy}
          disabled={!settings.backupFolder}
          onClick={() => {
            setBusy(true);
            void perform(async () => {
              await call('backup.create', {
                folder: settings.backupFolder,
                includeAudio: settings.backupAudio,
              });
              await load();
            }, t('backupCreated')).finally(() => setBusy(false));
          }}
        >
          {t('backupNow')}
        </Button>
      </div>
      {backups.length ? (
        backups.map((backup) => (
          <div className="backup-row" key={backup.path}>
            <Cloud size={18} />
            <div>
              <strong>{dateLabel(backup.createdAt, settings.uiLanguage)}</strong>
              <small>
                {backup.name} · {size(backup.size)}
              </small>
            </div>
            <Button
              variant="ghost"
              onClick={() =>
                void perform(async () => {
                  const data = await call<Record<string, unknown>>('backup.preview', { path: backup.path });
                  setPreview({ path: backup.path, data });
                })
              }
            >
              {t('preview')}
            </Button>
          </div>
        ))
      ) : (
        <p className="muted small">{t('noBackups')}</p>
      )}
      {preview && (
        <div className="backup-preview">
          <div className="section-action">
            <h3>{t('backupPreview')}</h3>
            <IconButton icon={X} label={t('close')} onClick={() => setPreview(null)} />
          </div>
          <div className="preview-counts">
            {(['lectures', 'subjects', 'materials', 'versions'] as const).map((key) => (
              <div key={key}>
                <strong>{String(preview.data[key] ?? 0)}</strong>
                <span>{t(key)}</span>
              </div>
            ))}
          </div>
          <p className="muted small">
            {t('backupAudio')}: {preview.data.audioIncluded ? '✓' : '—'} ·{' '}
            {size(Number(preview.data.bytes) || 0)}
          </p>
          <p>{t('restoreHint')}</p>
          <Button
            variant="primary"
            icon={RefreshCw}
            busy={busy}
            onClick={() => {
              setBusy(true);
              void perform(async () => {
                await call('backup.restore', { path: preview.path });
                setPreview(null);
              }, t('backupRestored')).finally(() => setBusy(false));
            }}
          >
            {t('restoreBackup')}
          </Button>
        </div>
      )}
    </div>
  );
}
function UsageView({ lectureIds, t, perform }: { lectureIds: string[]; t: T; perform: Perform }) {
  const [data, setData] = useState<LectureDetail['usage']>([]);
  const [loaded, setLoaded] = useState(false);
  return (
    <details
      className="usage-view"
      onToggle={(e) => {
        if (e.currentTarget.open && !loaded) {
          setLoaded(true);
          void perform(async () => {
            const all: LectureDetail['usage'] = [];
            for (const id of lectureIds) {
              const detail = await call<LectureDetail>('lecture.get', { lectureId: id });
              all.push(...detail.usage);
            }
            setData(all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
          });
        }
      }}
    >
      <summary>{t('usage')}</summary>
      {data.length ? (
        data.map((usage) => (
          <div className="usage-row" key={usage.id}>
            <strong>{usage.operation}</strong>
            <span>
              {usage.model} · {dateLabel(usage.createdAt, 'en')}
            </span>
            <pre>{JSON.stringify(usage.data, null, 2)}</pre>
          </div>
        ))
      ) : (
        <p className="muted small">{t('noUsage')}</p>
      )}
    </details>
  );
}
function CustomActionsEditor({
  actions: items,
  settings,
  t,
  perform,
  onRefresh,
}: {
  actions: CustomAction[];
  settings: Settings;
  t: T;
  perform: Perform;
  onRefresh: () => Promise<void>;
}) {
  const blank: CustomAction = {
    id: '',
    name: '',
    icon: '✨',
    instructions: '',
    language: settings.outputLanguage,
    model: '',
    format: 'markdown',
    pinned: true,
  };
  const [draft, setDraft] = useState<CustomAction | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="section-action">
        <h3>{t('customActions')}</h3>
        <Button icon={Plus} onClick={() => setDraft({ ...blank })}>
          {t('newAction')}
        </Button>
      </div>
      {items.map((action) => (
        <div className="custom-action-row" key={action.id}>
          <span className="custom-action-icon">{action.icon}</span>
          <div>
            <strong>{action.name}</strong>
            <small>
              {languageNames[action.language]} · {action.model || t('inheritModel')}
              {action.pinned ? ' · ★' : ''}
            </small>
          </div>
          <IconButton icon={Pencil} label={t('edit')} onClick={() => setDraft({ ...action })} />
          <IconButton
            icon={Trash2}
            label={t('delete')}
            onClick={() =>
              void perform(async () => {
                await call('action.delete', { id: action.id });
                await onRefresh();
              })
            }
          />
        </div>
      ))}
      {!items.length && !draft && <p className="muted">{t('noVersionsBody')}</p>}
      {draft && (
        <div className="custom-action-form">
          <div className="form-grid">
            <Field label={t('actionName')}>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                maxLength={100}
              />
            </Field>
            <Field label={t('icon')}>
              <input
                value={draft.icon}
                onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
                maxLength={8}
              />
            </Field>
          </div>
          <Field label={t('instructions')}>
            <textarea
              rows={6}
              value={draft.instructions}
              onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
            />
          </Field>
          <div className="form-grid">
            <Field label={t('targetLanguage')}>
              <Languages
                t={t}
                value={draft.language}
                onChange={(v) => v !== 'auto' && setDraft({ ...draft, language: v })}
              />
            </Field>
            <Field label={t('model')}>
              <Select value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })}>
                <option value="">{t('inheritModel')}</option>
                {MODEL_CATALOG.text.map((model) => (
                  <option key={model}>{model}</option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t('format')}>
            <Select
              value={draft.format}
              onChange={(e) => setDraft({ ...draft, format: e.target.value as CustomAction['format'] })}
            >
              <option value="markdown">Markdown</option>
              <option value="text">TXT</option>
              <option value="json">JSON</option>
            </Select>
          </Field>
          <Toggle
            label={t('pin')}
            checked={draft.pinned}
            onChange={(v) => setDraft({ ...draft, pinned: v })}
          />
          <div className="row end">
            <Button onClick={() => setDraft(null)}>{t('cancel')}</Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={!draft.name.trim() || !draft.instructions.trim()}
              onClick={() => {
                setBusy(true);
                void perform(async () => {
                  await call('action.save', { ...draft, id: draft.id || undefined });
                  await onRefresh();
                  setDraft(null);
                }, t('saved')).finally(() => setBusy(false));
              }}
            >
              {t('save')}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
function ActionsDialog({
  settings,
  custom,
  version,
  selectedText,
  t,
  onRun,
  onClose,
}: {
  settings: Settings;
  custom: CustomAction[];
  version: Version | undefined;
  selectedText: string;
  t: T;
  onRun: (
    action: string,
    scope: string,
    text: string,
    language: Language,
    customId?: string,
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [scope, setScope] = useState(selectedText ? 'selection' : version ? 'version' : 'lecture');
  const [language, setLanguage] = useState(settings.outputLanguage);
  const [busy, setBusy] = useState('');
  async function run(action: string, customId?: string) {
    setBusy(customId || action);
    await onRun(action, scope, selectedText, language, customId);
    setBusy('');
  }
  return (
    <Modal title={t('quickActions')} onClose={onClose} t={t}>
      <div className="form-grid">
        <Field label={t('actionScope')}>
          <Select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="lecture">{t('entireLecture')}</option>
            <option value="version" disabled={!version}>
              {t('selectedVersion')}
              {version ? ` · ${version.title}` : ''}
            </option>
            <option value="selection" disabled={!selectedText}>
              {t('selectedText')}
            </option>
          </Select>
        </Field>
        <Field label={t('targetLanguage')}>
          <Languages t={t} value={language} onChange={(v) => v !== 'auto' && setLanguage(v)} />
        </Field>
      </div>
      {scope === 'selection' && (
        <div className="selection-preview">
          <small>
            {selectedText.length} {t('selectedCharacters')}
          </small>
          <p>
            {selectedText.slice(0, 600)}
            {selectedText.length > 600 ? '…' : ''}
          </p>
        </div>
      )}
      <div className="actions-grid">
        {actions.map(({ id, label, icon: Icon }) => (
          <button key={id} disabled={!!busy} onClick={() => void run(id)}>
            {busy === id ? <LoaderCircle size={20} className="spin" /> : <Icon size={20} />}
            <span>{t(label)}</span>
            <ChevronRight size={14} />
          </button>
        ))}
        {custom
          .filter((a) => a.pinned)
          .map((action) => (
            <button key={action.id} disabled={!!busy} onClick={() => void run('custom', action.id)}>
              <span className="custom-action-icon">{action.icon}</span>
              <span>{action.name}</span>
              {busy === action.id ? <LoaderCircle size={14} className="spin" /> : <ChevronRight size={14} />}
            </button>
          ))}
      </div>
      {custom.some((a) => !a.pinned) && (
        <details>
          <summary>{t('customActions')}</summary>
          {custom
            .filter((a) => !a.pinned)
            .map((action) => (
              <Button disabled={!!busy} key={action.id} onClick={() => void run('custom', action.id)}>
                {action.icon} {action.name}
              </Button>
            ))}
        </details>
      )}
    </Modal>
  );
}
function MaterialsView({
  materials,
  t,
  perform,
  onImport,
}: {
  materials: Material[];
  t: T;
  perform: Perform;
  onImport: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (!materials.length)
    return (
      <Empty icon={FolderOpen} title={t('noMaterials')} body={t('noMaterialsBody')} compact>
        <Button icon={Plus} onClick={onImport}>
          {t('addFiles')}
        </Button>
        <small>{t('filesHint')}</small>
      </Empty>
    );
  return (
    <div className="materials-view">
      <div className="section-action">
        <span className="muted">
          {materials.length} {t('materials').toLocaleLowerCase()}
        </span>
        <Button icon={Plus} onClick={onImport}>
          {t('addFiles')}
        </Button>
      </div>
      {materials.map((material) => (
        <div className={`material-card ${material.status}`} key={material.id}>
          <div className="material-header">
            <span className="material-icon">
              {material.mime.startsWith('audio') ? <FileAudio size={21} /> : <FileText size={21} />}
            </span>
            <div>
              <strong>{material.name}</strong>
              <small>
                {size(material.size)} · {material.pages.length} {t('pages')}
                {material.pages.some((page) => page.ocr) ? ` · ${t('ocr')}` : ''}
              </small>
            </div>
            {material.status === 'processing' ? (
              <LoaderCircle size={18} className="spin" />
            ) : (
              <IconButton
                icon={ExternalLink}
                label={t('originalFile')}
                onClick={() => void perform(() => call('material.open', { id: material.id }))}
              />
            )}
          </div>
          {material.error && (
            <div className="material-error">
              <AlertTriangle size={14} />
              <p>{material.error}</p>
              <Button
                icon={RefreshCw}
                onClick={() => void perform(() => call('material.retry', { id: material.id }))}
              >
                {t('retry')}
              </Button>
            </div>
          )}
          {material.pages.length > 0 && (
            <Button
              variant="ghost"
              icon={open === material.id ? ChevronDown : ChevronRight}
              onClick={() => setOpen(open === material.id ? null : material.id)}
            >
              {t('showText')}
            </Button>
          )}
          {open === material.id && (
            <div className="material-pages">
              {material.pages.map((page) => (
                <div key={page.page}>
                  <span className="column-label">
                    {t('page')} {page.page}
                    {page.ocr ? ` · ${t('ocr')}` : ''}
                  </span>
                  <Markdown text={page.text} />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
function ExportDialog({
  detail,
  versionId,
  t,
  perform,
  onClose,
}: {
  detail: LectureDetail;
  versionId: string;
  t: T;
  perform: Perform;
  onClose: () => void;
}) {
  const [version, setVersion] = useState(versionId || detail.versions[0]?.id || '');
  const [format, setFormat] = useState('pdf');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={t('exportTitle')}
      subtitle={detail.lecture.title}
      onClose={onClose}
      t={t}
      footer={
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button
            variant="primary"
            icon={Download}
            busy={busy}
            disabled={!['audio', 'package'].includes(format) && !version}
            onClick={() => {
              setBusy(true);
              void perform(async () => {
                const result = await call<unknown>('export.lecture', {
                  lectureId: detail.lecture.id,
                  versionId: version || undefined,
                  format,
                });
                if (result) onClose();
              }).finally(() => setBusy(false));
            }}
          >
            {t('export')}
          </Button>
        </>
      }
    >
      <Field label={t('format')}>
        <div className="export-formats">
          {[
            { id: 'pdf', label: 'PDF', icon: FileText },
            { id: 'docx', label: 'DOCX', icon: FileText },
            { id: 'md', label: 'Markdown', icon: FileText },
            { id: 'txt', label: 'TXT', icon: FileText },
            { id: 'audio', label: t('originalAudio'), icon: FileAudio },
            { id: 'package', label: t('portablePackage'), icon: Folder },
          ].map(({ id, label, icon: Icon }) => (
            <button className={format === id ? 'active' : ''} key={id} onClick={() => setFormat(id)}>
              <Icon size={22} />
              <span>{label}</span>
              {format === id && <Check size={14} />}
            </button>
          ))}
        </div>
      </Field>
      {!['audio', 'package'].includes(format) && (
        <Field label={t('exportVersion')}>
          <Select value={version} onChange={(e) => setVersion(e.target.value)}>
            {detail.versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.title} · {versionLabel(v.kind, t)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <p className="privacy-text">
        <ShieldCheck size={16} />
        {t('exportHint')}
      </p>
    </Modal>
  );
}

// Resizable chat panel. Widths mirror styles.css: `.sidebar` is 220px and the main area keeps at
// least 420px (lecture list + a readable document column). Without a stored preference narrow
// windows (≤1200px, e.g. laptops with 125–150% scaling) start from the compact 310px width.
const CHAT_WIDTH_KEY = 'lecturedesk.chatWidth';
const CHAT_DEFAULT_WIDTH = 345;
const CHAT_COMPACT_WIDTH = 310;
const CHAT_COMPACT_VIEWPORT = 1200;
const CHAT_MIN_WIDTH = 300;
const CHAT_MAX_WIDTH = 900;
const SIDEBAR_WIDTH = 220;
const MAIN_MIN_WIDTH = 420;
const CHAT_KEY_STEP = 16;
const chatMaxWidth = (viewport: number) =>
  Math.max(CHAT_MIN_WIDTH, Math.min(CHAT_MAX_WIDTH, viewport - SIDEBAR_WIDTH - MAIN_MIN_WIDTH));
const clampChatWidth = (width: number, viewport: number) =>
  Math.round(Math.min(chatMaxWidth(viewport), Math.max(CHAT_MIN_WIDTH, width)));
const defaultChatWidth = (viewport: number) =>
  viewport <= CHAT_COMPACT_VIEWPORT ? CHAT_COMPACT_WIDTH : CHAT_DEFAULT_WIDTH;
function readChatWidth(): number | null {
  try {
    const value = Number(window.localStorage.getItem(CHAT_WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
function saveChatWidth(width: number | null) {
  try {
    if (width === null) window.localStorage.removeItem(CHAT_WIDTH_KEY);
    else window.localStorage.setItem(CHAT_WIDTH_KEY, String(Math.round(width)));
  } catch {
    /* A per-device convenience: the default width is used when storage is unavailable. */
  }
}
/** Chat width preference: the stored value survives a temporarily smaller window and is re-clamped on resize. */
function useChatWidth() {
  const [preferred, setPreferred] = useState<number | null>(readChatWidth);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = () => setViewport(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return {
    width: clampChatWidth(preferred ?? defaultChatWidth(viewport), viewport),
    max: chatMaxWidth(viewport),
    reset: () => {
      setPreferred(null);
      saveChatWidth(null);
    },
    preview: (next: number) => setPreferred(clampChatWidth(next, window.innerWidth)),
    commit: (next: number) => {
      const value = clampChatWidth(next, window.innerWidth);
      setPreferred(value);
      saveChatWidth(value);
    },
  };
}
function ChatResizeHandle({ width, max, preview, commit, reset, t }: ReturnType<typeof useChatWidth> & { t: T }) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; last: number } | null>(null);
  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add('chat-resizing');
    return () => document.body.classList.remove('chat-resizing');
  }, [dragging]);
  const finish = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    commit(current.last);
  };
  return (
    <div
      className={`chat-resize-handle ${dragging ? 'dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('resizeChat')}
      aria-valuenow={width}
      aria-valuemin={CHAT_MIN_WIDTH}
      aria-valuemax={max}
      aria-valuetext={`${width}px`}
      title={t('resizeChatHint')}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault(); // No text selection while dragging.
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, last: width };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        // The handle sits on the panel's left edge: moving left widens the panel.
        current.last = clampChatWidth(current.startWidth + current.startX - event.clientX, window.innerWidth);
        preview(current.last);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={reset}
      onKeyDown={(event) => {
        const step =
          event.key === 'ArrowLeft' ? CHAT_KEY_STEP : event.key === 'ArrowRight' ? -CHAT_KEY_STEP : 0;
        if (!step) return;
        event.preventDefault();
        commit(width + step);
      }}
    />
  );
}
function ChatPanel({
  seed,
  snapshot,
  detail,
  selected,
  currentSubject,
  t,
  perform,
  onClose,
  onLecture,
}: {
  seed: number;
  snapshot: LibrarySnapshot;
  detail: LectureDetail | null;
  selected: string | null;
  currentSubject: string | null;
  t: T;
  perform: Perform;
  onClose: () => void;
  onLecture: (id: string) => void;
}) {
  const [context, setContext] = useState<ChatContext>({
    scope: 'lecture',
    lectureIds: selected ? [selected] : [],
    subjectId: currentSubject,
    materialIds: [],
  });
  const [mode, setMode] = useState<ChatMode>('strict');
  const [webAllowed, setWebAllowed] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(false);
  const [contextOpen, setContextOpen] = useState(true);
  const chatWidth = useChatWidth();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void perform(async () => setConversations(await call<Conversation[]>('chat.list')));
  }, [perform]);
  useEffect(() => {
    if (!conversation)
      setContext((c) => ({
        ...c,
        lectureIds: c.scope === 'lecture' ? (selected ? [selected] : []) : c.lectureIds,
        subjectId: c.subjectId || currentSubject,
      }));
  }, [selected, currentSubject, conversation]);
  useEffect(() => {
    if (seed) {
      setConversation(null);
      setMessages([]);
      setContext({
        scope: 'lecture',
        lectureIds: selected ? [selected] : [],
        subjectId: null,
        materialIds: [],
      });
      setContextOpen(true);
    }
  }, [seed]);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);
  const lectures = snapshot.lectures.filter((l) => !l.deletedAt);
  const materials = (snapshot.materials || []).filter((m) => m.status === 'ready');
  const contextValid =
    context.scope === 'library' ||
    (context.scope === 'subject' && !!context.subjectId) ||
    (['lecture', 'lectures'].includes(context.scope) && context.lectureIds.length > 0) ||
    context.materialIds.length > 0;
  const selectedNames =
    context.scope === 'library'
      ? t('libraryContext')
      : context.scope === 'subject'
        ? snapshot.subjects.find((s) => s.id === context.subjectId)?.name || t('subjectContext')
        : context.lectureIds
            .map((id) => snapshot.lectures.find((l) => l.id === id)?.title)
            .filter(Boolean)
            .join(', ');
  function reset() {
    setConversation(null);
    setMessages([]);
    setHistory(false);
    setContextOpen(true);
  }
  function changeContext(patch: Partial<ChatContext>) {
    if (conversation) {
      setConversation(null);
      setMessages([]);
    }
    setContext((c) => ({ ...c, ...patch }));
  }
  async function openConversation(value: Conversation) {
    const result = await perform(() => call<ChatMessage[]>('chat.messages', { conversationId: value.id }));
    if (result) {
      setConversation(value);
      setMessages(result);
      setContext(value.context);
      setMode(value.mode);
      setWebAllowed(value.mode === 'web');
      setHistory(false);
      setContextOpen(false);
    }
  }
  async function send() {
    if (!input.trim() || !contextValid || busy || !snapshot.hasKey || (mode === 'web' && !webAllowed)) return;
    setBusy(true);
    const message = input.trim();
    let id = conversation?.id;
    await perform(async () => {
      if (!id) {
        const created = await call<Conversation>('chat.create', {
          context,
          mode,
          title: message.slice(0, 70),
        });
        id = created.id;
        setConversation(created);
        setConversations(await call<Conversation[]>('chat.list'));
      }
      setInput('');
      setContextOpen(false);
      const optimistic: ChatMessage = {
        id: 'pending',
        conversationId: id!,
        role: 'user',
        content: message,
        sources: [],
        createdAt: new Date().toISOString(),
      };
      setMessages((m) => [...m, optimistic]);
      try {
        await call<ChatMessage>('chat.send', { conversationId: id, message });
      } finally {
        setMessages(await call<ChatMessage[]>('chat.messages', { conversationId: id }));
      }
    });
    setBusy(false);
  }
  return (
    <aside className="chat-panel" style={{ '--chat-width': `${chatWidth.width}px` } as React.CSSProperties}>
      <ChatResizeHandle {...chatWidth} t={t} />
      <header className="chat-header">
        <span className="chat-brand-icon">
          <Sparkles size={18} />
        </span>
        <div>
          <strong>{t('chatTitle')}</strong>
          <small>{t('chatSubtitle')}</small>
        </div>
        <IconButton icon={PanelRightClose} label={t('close')} onClick={onClose} />
      </header>
      <div className="chat-toolbar">
        <Button variant="ghost" icon={Plus} disabled={busy} onClick={reset}>
          {t('newConversation')}
        </Button>
        <IconButton icon={History} label={t('history')} onClick={() => setHistory((v) => !v)} />
      </div>
      {history ? (
        <div className="conversation-history">
          <h3>{t('history')}</h3>
          {conversations.length ? (
            conversations.map((item) => (
              <button
                key={item.id}
                className={item.id === conversation?.id ? 'active' : ''}
                disabled={busy}
                onClick={() => void openConversation(item)}
              >
                <MessageSquare size={16} />
                <span>
                  <strong>{item.title}</strong>
                  <small>{dateLabel(item.createdAt, snapshot.settings.uiLanguage)}</small>
                </span>
                <ChevronRight size={14} />
              </button>
            ))
          ) : (
            <p className="muted">{t('noConversations')}</p>
          )}
        </div>
      ) : (
        <>
          <div className="chat-context">
            <button className="context-summary" onClick={() => setContextOpen((v) => !v)}>
              <FolderOpen size={15} />
              <span>
                <small>{t('context')}</small>
                <strong>{selectedNames || t('chatNoContext')}</strong>
              </span>
              <ChevronDown size={14} />
            </button>
            {contextOpen && (
              <div className="context-editor">
                <Field label={t('context')}>
                  <Select
                    value={context.scope}
                    disabled={busy}
                    onChange={(e) =>
                      changeContext({
                        scope: e.target.value as ChatContext['scope'],
                        lectureIds:
                          e.target.value === 'lecture' ? (selected ? [selected] : []) : context.lectureIds,
                      })
                    }
                  >
                    <option value="lecture">{t('lectureContext')}</option>
                    <option value="lectures">{t('multipleContext')}</option>
                    <option value="subject">{t('subjectContext')}</option>
                    <option value="library">{t('libraryContext')}</option>
                  </Select>
                </Field>
                {context.scope === 'lecture' && (
                  <Select
                    value={context.lectureIds[0] || ''}
                    disabled={busy}
                    onChange={(e) => changeContext({ lectureIds: e.target.value ? [e.target.value] : [] })}
                  >
                    <option value="">{t('chooseLecture')}</option>
                    {lectures.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.title}
                      </option>
                    ))}
                  </Select>
                )}
                {context.scope === 'lectures' && (
                  <div className="context-checklist">
                    {lectures.map((l) => (
                      <label key={l.id}>
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={context.lectureIds.includes(l.id)}
                          onChange={(e) =>
                            changeContext({
                              lectureIds: e.target.checked
                                ? [...context.lectureIds, l.id]
                                : context.lectureIds.filter((id) => id !== l.id),
                            })
                          }
                        />
                        {l.title}
                      </label>
                    ))}
                  </div>
                )}
                {context.scope === 'subject' && (
                  <Select
                    value={context.subjectId || ''}
                    disabled={busy}
                    onChange={(e) => changeContext({ subjectId: e.target.value || null })}
                  >
                    <option value="">{t('subject')}</option>
                    {snapshot.subjects.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                )}
                {materials.length > 0 && (
                  <Field label={t('additionalFiles')}>
                    <div className="context-checklist">
                      {materials.map((material) => (
                        <label key={material.id}>
                          <input
                            type="checkbox"
                            disabled={busy}
                            checked={context.materialIds.includes(material.id)}
                            onChange={(e) =>
                              changeContext({
                                materialIds: e.target.checked
                                  ? [...context.materialIds, material.id]
                                  : context.materialIds.filter((id) => id !== material.id),
                              })
                            }
                          />
                          {material.name}
                        </label>
                      ))}
                    </div>
                  </Field>
                )}
                <Field label={t('mode')}>
                  <Select
                    value={mode}
                    disabled={busy}
                    onChange={(e) => {
                      reset();
                      setMode(e.target.value as ChatMode);
                      setWebAllowed(false);
                    }}
                  >
                    <option value="strict">{t('strict')}</option>
                    <option value="knowledge">{t('knowledge')}</option>
                    <option value="web">{t('web')}</option>
                  </Select>
                </Field>
                {mode === 'web' && (
                  <label className="web-permission">
                    <input
                      type="checkbox"
                      checked={webAllowed}
                      disabled={busy}
                      onChange={(e) => {
                        if (conversation) reset();
                        setWebAllowed(e.target.checked);
                      }}
                    />
                    <span>
                      {t('webEnable')}
                      <small>{t('webNotice')}</small>
                    </span>
                  </label>
                )}
              </div>
            )}
          </div>
          <div className="chat-messages">
            {!messages.length ? (
              <div className="chat-empty">
                <div>
                  <Sparkles size={28} />
                </div>
                <h3>{t('chatEmpty')}</h3>
                <p>{t('chatEmptyBody')}</p>
              </div>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={`chat-message ${message.role}`}>
                  <div className="message-role">
                    {message.role === 'assistant' ? <Sparkles size={13} /> : <Circle size={12} />}
                    <span>{message.role === 'assistant' ? 'LectureDesk' : t('you')}</span>
                  </div>
                  <Markdown
                    text={message.content}
                    onLink={(url) => void perform(() => call('shell.url', { url }))}
                  />
                  {message.sources?.length > 0 && (
                    <div className="message-sources">
                      <small>{t('sources')}</small>
                      {message.sources.map((source, i) => (
                        <button
                          key={i}
                          // Sources of lectures deleted permanently from Trash can no longer be opened.
                          disabled={
                            !source.url &&
                            ((!!source.lectureId &&
                              !snapshot.lectures.some((l) => l.id === source.lectureId)) ||
                              (!source.lectureId &&
                                !!source.materialId &&
                                !(snapshot.materials || []).some((m) => m.id === source.materialId)))
                          }
                          onClick={() => {
                            if (source.url) void perform(() => call('shell.url', { url: source.url }));
                            else if (source.lectureId) onLecture(source.lectureId);
                            else if (source.materialId)
                              void perform(() => call('material.open', { id: source.materialId }));
                          }}
                        >
                          {source.url ? <ExternalLink size={11} /> : <FileText size={11} />}
                          <span>
                            {source.title}
                            {source.page ? ` · ${t('page')} ${source.page}` : ''}
                            {source.start !== undefined ? ` · ${time(source.start)}` : ''}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              ))
            )}
            {busy && (
              <div className="chat-thinking">
                <LoaderCircle size={15} className="spin" />
                {t('thinking')}
              </div>
            )}
            <div ref={end} />
          </div>
          <div className="chat-composer">
            <div className="chat-mode-indicator">
              <ShieldCheck size={12} />
              {t(mode)}
              {mode === 'web' && !webAllowed && <AlertTriangle size={12} />}
            </div>
            <div className="composer-input">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={t('askPlaceholder')}
                rows={3}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <button
                aria-label={t('send')}
                disabled={
                  !input.trim() ||
                  !contextValid ||
                  busy ||
                  !snapshot.hasKey ||
                  (mode === 'web' && !webAllowed)
                }
                onClick={() => void send()}
              >
                {busy ? <LoaderCircle size={17} className="spin" /> : <Send size={17} />}
              </button>
            </div>
            {!snapshot.hasKey && <small>{t('noKey')}</small>}
            {!contextValid && <small>{t('chatNoContext')}</small>}
          </div>
        </>
      )}
    </aside>
  );
}
