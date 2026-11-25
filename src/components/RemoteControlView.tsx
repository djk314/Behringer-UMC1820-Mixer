import React from 'react';
import { Tablet, Wifi, WifiOff } from 'lucide-react';

export type RemoteWsStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface RemoteControlViewProps {
  wsAddress: string;
  onChangeWsAddress: (next: string) => void;
  wsStatus: RemoteWsStatus;
  wsError: string | null;
  remoteDeviceName: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}

export const RemoteControlView: React.FC<RemoteControlViewProps> = ({
  wsAddress,
  onChangeWsAddress,
  wsStatus,
  wsError,
  remoteDeviceName,
  onConnect,
  onDisconnect,
}) => {
  const isHttpsPage =
    typeof window !== 'undefined' && window.location.protocol === 'https:';

  return (
    <div className="flex flex-col gap-5 max-w-5xl">
      {/* iPad Direct Safari Usage Card */}
      <div className="bg-[#131720] border border-sky-500/30 rounded-md p-5 flex flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <Tablet className="w-5 h-5 text-sky-400" />
          <h2 className="text-base font-semibold text-slate-100">
            Télécommande iPad via Safari (Serveur intégré dans l'application Mac)
          </h2>
        </div>
        <p className="text-xs text-slate-300 leading-relaxed">
          L'application native Mac (<span className="font-mono text-amber-300">umc1820-studio-mixer</span>) intègre désormais un serveur HTTP + WebSocket léger sur le port <span className="font-mono text-sky-300">8080</span> et un serveur OSC UDP sur le port <span className="font-mono text-emerald-300">9000</span>.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="bg-[#0B0E14] border border-[#232936] rounded p-3">
            <div className="font-semibold text-amber-300 mb-1">1. Lancer l'appli sur le Mac</div>
            <div className="text-slate-400 leading-relaxed">
              Dans la barre supérieure, repérez l'adresse affichée (ex. <span className="font-mono text-sky-300">http://192.168.1.42:8080</span>).
            </div>
          </div>
          <div className="bg-[#0B0E14] border border-[#232936] rounded p-3">
            <div className="font-semibold text-sky-300 mb-1">2. Ouvrir dans Safari sur iPad</div>
            <div className="text-slate-400 leading-relaxed">
              Connectez l'iPad au même Wi-Fi et saisissez cette adresse dans Safari. Astuce : utilisez « Sur l'écran d'accueil » pour l'utiliser en plein écran.
            </div>
          </div>
          <div className="bg-[#0B0E14] border border-[#232936] rounded p-3">
            <div className="font-semibold text-emerald-300 mb-1">3. Contrôle temps réel</div>
            <div className="text-slate-400 leading-relaxed">
              Faders tactiles multi-touch, VU-mètres 20 Hz, Mute/Solo, Gain, EQ 5 bandes, Aux Stéréo/Mono, I/O matériel, paramètres de plugins et lecteur MP3/WAV.
            </div>
          </div>
        </div>
      </div>

      {/* Direct WebSocket Bridge from this Web Console */}
      <div className="bg-[#131720] border border-[#232936] rounded-md p-5 flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              Connexion WebSocket directe depuis cette console Web
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Synchronise directement les faders, EQ, envois Aux et VU-mètres de l'onglet « Console de mixage » avec le Mac.
            </p>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono border ${
              wsStatus === 'connected'
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                : wsStatus === 'connecting'
                  ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                  : wsStatus === 'error'
                    ? 'bg-red-500/15 border-red-500/40 text-red-300'
                    : 'bg-[#0B0E14] border-[#232936] text-slate-400'
            }`}
          >
            {wsStatus === 'connected' ? (
              <Wifi className="w-3.5 h-3.5" />
            ) : (
              <WifiOff className="w-3.5 h-3.5" />
            )}
            {wsStatus === 'connected'
              ? `Connecté (${remoteDeviceName ?? 'Mac'})`
              : wsStatus === 'connecting'
                ? 'Connexion...'
                : wsStatus === 'error'
                  ? 'Erreur connexion'
                  : 'Déconnecté'}
          </span>
        </div>

        {isHttpsPage && (
          <div className="bg-amber-500/10 border border-amber-500/35 rounded p-3 text-xs text-amber-200 leading-relaxed">
            Cette page est ouverte en <span className="font-mono">HTTPS</span> : par sécurité, Safari/Chrome bloquent les connexions WebSocket locales <span className="font-mono">ws://192.168.x.x</span> depuis une page HTTPS. Sur votre iPad, ouvrez simplement l'URL <span className="font-mono text-sky-300">http://&lt;IP-du-Mac&gt;:8080</span> affichée dans l'application Mac (ou exécutez cette interface en local via HTTP).
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="text"
            aria-label="Adresse WebSocket du Mac"
            value={wsAddress}
            onChange={(e) => onChangeWsAddress(e.target.value)}
            placeholder="ws://192.168.1.42:8080/ws"
            className="flex-1 min-w-[240px] bg-[#0B0E14] border border-[#2D3545] rounded px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
          />
          {wsStatus === 'connected' ? (
            <button
              type="button"
              onClick={onDisconnect}
              className="px-4 py-2 text-xs font-semibold bg-red-500/20 text-red-300 border border-red-500/40 rounded hover:bg-red-500/30 cursor-pointer"
            >
              Déconnecter
            </button>
          ) : (
            <button
              type="button"
              onClick={onConnect}
              className="px-4 py-2 text-xs font-semibold bg-sky-500 text-slate-950 rounded hover:bg-sky-400 cursor-pointer"
            >
              Connecter au Mac
            </button>
          )}
        </div>

        {wsError && (
          <div className="text-xs font-mono text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
            {wsError}
          </div>
        )}
      </div>

      {/* OSC UDP Reference Card */}
      <div className="bg-[#131720] border border-[#232936] rounded-md p-5 flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-slate-100">
          Compatibilité OSC UDP (port 9000 — TouchOSC / Lemur / contrôleurs)
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs font-mono text-slate-300">
          <div className="bg-[#0B0E14] border border-[#232936] rounded px-3 py-2">
            /strip/1..17/volume <span className="text-slate-500">(float 0.0–1.0)</span>
          </div>
          <div className="bg-[#0B0E14] border border-[#232936] rounded px-3 py-2">
            /strip/master/volume <span className="text-slate-500">(float 0.0–1.0)</span>
          </div>
          <div className="bg-[#0B0E14] border border-[#232936] rounded px-3 py-2">
            /strip/1..8/gain <span className="text-slate-500">(-12.0 à +24.0 dB)</span>
          </div>
          <div className="bg-[#0B0E14] border border-[#232936] rounded px-3 py-2">
            /strip/1..17/mute · /solo <span className="text-slate-500">(0 ou 1)</span>
          </div>
          <div className="bg-[#0B0E14] border border-[#232936] rounded px-3 py-2">
            /strip/1..16/aux/1..8 <span className="text-slate-500">(float 0.0–1.0)</span>
          </div>
          <div className="bg-[#0B0E14] border border-[#232936] rounded px-3 py-2">
            /strip/1..17/eq/low|low_mid|mid|high_mid|high <span className="text-slate-500">(±15 dB)</span>
          </div>
        </div>
      </div>
    </div>
  );
};
