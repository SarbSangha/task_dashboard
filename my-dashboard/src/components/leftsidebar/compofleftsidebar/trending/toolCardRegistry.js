import { FreepikGenerationCard } from '../workspace/tabs/freepik-capture/FreepikGenerationCard';
import FreepikGenerationDrawer from '../workspace/tabs/freepik-capture/FreepikGenerationDrawer';
import { DownloadCard as FreepikDownloadCard } from '../workspace/tabs/freepik-capture/DownloadCard';
import { HeygenGenerationCard } from '../workspace/tabs/heygen-capture/HeygenGenerationCard';
import HeygenGenerationDrawer from '../workspace/tabs/heygen-capture/HeygenGenerationDrawer';
import { HiggsfieldGenerationCard } from '../workspace/tabs/higgsfield-capture/HiggsfieldGenerationCard';
import HiggsfieldGenerationDrawer from '../workspace/tabs/higgsfield-capture/HiggsfieldGenerationDrawer';
import { EnvatoGenerationCard } from '../workspace/tabs/envato-capture/EnvatoGenerationCard';
import EnvatoGenerationDrawer from '../workspace/tabs/envato-capture/EnvatoGenerationDrawer';
import { DownloadCard as EnvatoDownloadCard } from '../workspace/tabs/envato-capture/DownloadCard';
import EnvatoDownloadDrawer from '../workspace/tabs/envato-capture/EnvatoDownloadDrawer';
import { FlowGenerationCard } from '../workspace/tabs/flow-capture/FlowGenerationCard';
import FlowGenerationDrawer from '../workspace/tabs/flow-capture/FlowGenerationDrawer';
import { ElevenLabsGenerationCard } from '../workspace/tabs/elevenlabs-capture/ElevenLabsGenerationCard';
import ElevenLabsGenerationDrawer from '../workspace/tabs/elevenlabs-capture/ElevenLabsGenerationDrawer';
import { SunoGenerationCard } from '../workspace/tabs/suno-capture/SunoGenerationCard';
import SunoGenerationDrawer from '../workspace/tabs/suno-capture/SunoGenerationDrawer';
import { EpidemicDownloadCard } from '../workspace/tabs/epidemicsound-capture/EpidemicDownloadCard';
import { EpidemicAdaptationCard } from '../workspace/tabs/epidemicsound-capture/EpidemicAdaptationCard';
import { SpliceDownloadCard } from '../workspace/tabs/splice-capture/SpliceDownloadCard';

/*
 * Which existing card (and detail drawer) renders each tool sheet in the
 * Records view, keyed `<tool>.<sheet>`. The server returns these sheets in
 * the tool's own list format (`format=native` on /rows), so the cards work
 * unchanged, admin actions in the drawers included.
 *
 *   prop    - the card's record prop name
 *   Drawer  - optional; `drawer: 'id'` drawers take generationId,
 *             `drawer: 'object'` ones take the record itself
 *
 * Sheets missing here (Freepik searches) use ToolRecordsTab's own card.
 */
const generation = (Card, Drawer) => ({ Card, prop: 'generation', Drawer, drawer: 'id' });

export const TOOL_CARDS = {
  'freepik.generations': generation(FreepikGenerationCard, FreepikGenerationDrawer),
  'freepik.downloads': { Card: FreepikDownloadCard, prop: 'download' },
  'heygen.generations': generation(HeygenGenerationCard, HeygenGenerationDrawer),
  'higgsfield.generations': generation(HiggsfieldGenerationCard, HiggsfieldGenerationDrawer),
  'envato.generations': generation(EnvatoGenerationCard, EnvatoGenerationDrawer),
  'envato.downloads': { Card: EnvatoDownloadCard, prop: 'download', Drawer: EnvatoDownloadDrawer, drawer: 'object' },
  'flow.generations': generation(FlowGenerationCard, FlowGenerationDrawer),
  'elevenlabs.generations': generation(ElevenLabsGenerationCard, ElevenLabsGenerationDrawer),
  'suno.generations': generation(SunoGenerationCard, SunoGenerationDrawer),
  'epidemicsound.downloads': { Card: EpidemicDownloadCard, prop: 'download' },
  'epidemicsound.adaptations': { Card: EpidemicAdaptationCard, prop: 'adaptation' },
  'splice.downloads': { Card: SpliceDownloadCard, prop: 'download' },
};

// Text-first tools keep their original screens; a records grid adds nothing.
export const ORIGINAL_SCREEN_TOOLS = new Set(['cursor', 'claudecode', 'figma']);
