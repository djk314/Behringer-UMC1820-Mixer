import React, { useState } from 'react';
import { Check, Copy, Download, FileCode2, FolderOpen } from 'lucide-react';
import { RUST_PROJECT_FILES } from '../data/rustProjectFiles';
import { buildZipArchive } from '../utils/zipBuilder';

export const RustCodeExplorer: React.FC = () => {
  const [selectedPath, setSelectedPath] = useState<string>(RUST_PROJECT_FILES[0].path);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const activeFile =
    RUST_PROJECT_FILES.find((f) => f.path === selectedPath) ?? RUST_PROJECT_FILES[0];

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(activeFile.content);
      setCopiedPath(activeFile.path);
      window.setTimeout(() => setCopiedPath(null), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleDownloadZip = () => {
    const blob = buildZipArchive(
      RUST_PROJECT_FILES.map((f) => ({
        path: `umc1820-studio-mixer/${f.path}`,
        content: f.content,
      }))
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'umc1820-studio-mixer-rust.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col lg:flex-row border border-[#232936] rounded-md bg-[#131720] overflow-hidden min-h-[640px]">
      {/* File Tree Sidebar */}
      <aside className="w-full lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-[#232936] bg-[#0F131B] flex flex-col justify-between">
        <div>
          <div className="px-4 py-3 border-b border-[#232936] flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-amber-400" />
            <span className="text-xs font-semibold text-slate-200">
              umc1820-studio-mixer (egui + cpal)
            </span>
          </div>

          <nav className="p-2 flex flex-col gap-1" aria-label="Fichiers du projet Rust">
            {RUST_PROJECT_FILES.map((file) => {
              const active = file.path === activeFile.path;
              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setSelectedPath(file.path)}
                  className={`flex items-center gap-2 px-3 py-2 rounded text-left text-xs font-mono transition-colors cursor-pointer ${
                    active
                      ? 'bg-[#1D2433] text-amber-300 border border-amber-500/30'
                      : 'text-slate-300 hover:bg-[#171C26] border border-transparent'
                  }`}
                >
                  <FileCode2 className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                  <span className="truncate">{file.path}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="p-4 border-t border-[#232936] flex flex-col gap-2">
          <p className="text-[11px] text-slate-400 leading-relaxed">
            Compatible macOS (CoreAudio · AU / VST3 / VST2) et Linux (ALSA / JACK · VST3 / VST2).
          </p>
          <button
            type="button"
            onClick={handleDownloadZip}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold bg-amber-400 text-slate-950 rounded hover:bg-amber-300 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            Télécharger le projet (.zip)
          </button>
        </div>
      </aside>

      {/* Code Viewer */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-4 py-3 border-b border-[#232936] flex flex-wrap items-center justify-between gap-3 bg-[#11151E]">
          <div className="min-w-0">
            <div className="text-xs font-mono font-semibold text-slate-100">
              {activeFile.path}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              {activeFile.description}
            </div>
          </div>

          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#1A202C] hover:bg-[#232B3A] text-slate-200 border border-[#2D3545] rounded cursor-pointer whitespace-nowrap shrink-0"
          >
            {copiedPath === activeFile.path ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                Copié
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                Copier le fichier
              </>
            )}
          </button>
        </div>

        <div className="flex-1 overflow-auto bg-[#0B0E14] p-4">
          <pre className="text-xs font-mono leading-relaxed text-slate-200 whitespace-pre">
            <code>{activeFile.content}</code>
          </pre>
        </div>
      </div>
    </div>
  );
};
