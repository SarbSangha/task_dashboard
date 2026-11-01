import KlingTab from './kling/KlingTab';
import FreepikExplorerBody from '../workspace/tabs/freepik-capture/FreepikExplorerBody';
import HeygenExplorerBody from '../workspace/tabs/heygen-capture/HeygenExplorerBody';
import HiggsfieldExplorerBody from '../workspace/tabs/higgsfield-capture/HiggsfieldExplorerBody';
import EnvatoExplorerBody from '../workspace/tabs/envato-capture/EnvatoExplorerBody';
import FlowExplorerBody from '../workspace/tabs/flow-capture/FlowExplorerBody';
import ElevenLabsExplorerBody from '../workspace/tabs/elevenlabs-capture/ElevenLabsExplorerBody';
import SunoExplorerBody from '../workspace/tabs/suno-capture/SunoExplorerBody';
import EpidemicExplorerBody from '../workspace/tabs/epidemicsound-capture/EpidemicExplorerBody';
import SpliceExplorerBody from '../workspace/tabs/splice-capture/SpliceExplorerBody';
import CursorExplorerBody from '../workspace/tabs/cursor-capture/CursorExplorerBody';
import ClaudeCodeExplorerBody from '../workspace/tabs/claude-code-capture/ClaudeCodeExplorerBody';
import FigmaExplorerBody from '../workspace/tabs/figma-capture/FigmaExplorerBody';

/*
 * The AI-tool tabs of the RMW Data panel, in display order. One entry per
 * tab: the panel builds the tab button, the header search box, the context
 * bar and the Excel export from this list.
 *
 * `key` is also the export slug (backend/routers/rmw_data_export_router.py
 * TOOLS) and the `trendings-content--<key>` class TrendingsPanel.css styles.
 * Every tool except Kling has admin-only capture APIs, so `adminOnly` hides
 * the tab from everyone else rather than showing an access-denied body.
 */
export const RMW_TOOL_TABS = [
  {
    key: 'kling',
    label: 'Kling',
    category: 'Video',
    adminOnly: false,
    description: 'Video generations from the shared Kling accounts, with owners, projects and credits.',
    searchPlaceholder: 'Search prompts, models, users, projects… (try department:Marketing status:resolved)',
    searchLabel: 'Search Kling generations',
    Body: KlingTab,
  },
  {
    key: 'freepik',
    label: 'Freepik',
    category: 'Image & video',
    adminOnly: true,
    description: 'Images and videos generated on Freepik, plus stock downloads and searches.',
    searchPlaceholder: 'Search prompts…',
    searchLabel: 'Search Freepik generations by prompt or creation id',
    Body: FreepikExplorerBody,
  },
  {
    key: 'heygen',
    label: 'HeyGen',
    category: 'Avatar video',
    adminOnly: true,
    description: 'Avatar videos rendered in HeyGen: scripts, avatars, voices and credits.',
    searchPlaceholder: 'Search scripts, avatars, voices…',
    searchLabel: 'Search HeyGen generations',
    Body: HeygenExplorerBody,
  },
  {
    key: 'higgsfield',
    label: 'Higgsfield',
    category: 'Video',
    adminOnly: true,
    description: 'Video and image generations from Higgsfield presets, with credits used and refunded.',
    searchPlaceholder: 'Search prompts, presets…',
    searchLabel: 'Search Higgsfield generations',
    Body: HiggsfieldExplorerBody,
  },
  {
    key: 'envato',
    label: 'Envato',
    category: 'Image & stock',
    adminOnly: true,
    description: 'Envato AI generations and stock items downloaded by the team.',
    searchPlaceholder: 'Search prompts, titles…',
    searchLabel: 'Search Envato generations and downloads',
    Body: EnvatoExplorerBody,
  },
  {
    key: 'flow',
    label: 'Flow',
    category: 'Video',
    adminOnly: true,
    description: 'Google Flow video generations by model, resolution and credits.',
    searchPlaceholder: 'Search prompts…',
    searchLabel: 'Search Flow generations',
    Body: FlowExplorerBody,
  },
  {
    key: 'elevenlabs',
    label: 'ElevenLabs',
    category: 'Voice',
    adminOnly: true,
    description: 'Speech and audio generated in ElevenLabs, by voice and credits.',
    searchPlaceholder: 'Search text, voices…',
    searchLabel: 'Search ElevenLabs generations',
    Body: ElevenLabsExplorerBody,
  },
  {
    key: 'suno',
    label: 'Suno',
    category: 'Music',
    adminOnly: true,
    description: 'Songs and music generated in Suno.',
    searchPlaceholder: 'Search prompts…',
    searchLabel: 'Search Suno generations',
    Body: SunoExplorerBody,
  },
  {
    key: 'epidemicsound',
    label: 'Epidemic Sound',
    category: 'Music',
    adminOnly: true,
    description: 'Tracks and sound effects downloaded or adapted from Epidemic Sound.',
    searchPlaceholder: 'Search tracks…',
    searchLabel: 'Search Epidemic Sound downloads',
    Body: EpidemicExplorerBody,
  },
  {
    key: 'splice',
    label: 'Splice',
    category: 'Samples',
    adminOnly: true,
    description: 'Samples downloaded from Splice.',
    searchPlaceholder: 'Search titles…',
    searchLabel: 'Search Splice downloads by title',
    Body: SpliceExplorerBody,
  },
  {
    key: 'cursor',
    label: 'Cursor',
    website: 'https://cursor.com',
    category: 'Code',
    adminOnly: true,
    description: 'Prompts from connected Cursor installs, plus model usage and cost.',
    searchPlaceholder: 'Search prompts, chats…',
    searchLabel: 'Search Cursor prompts and chat names',
    Body: CursorExplorerBody,
  },
  {
    key: 'claudecode',
    label: 'Claude Code',
    website: 'https://claude.ai',
    category: 'Code',
    adminOnly: true,
    description: 'Claude Code prompts and requests: models, tokens and cost.',
    searchPlaceholder: 'Search prompts, people, models…',
    searchLabel: 'Search Claude Code prompts, people and models',
    Body: ClaudeCodeExplorerBody,
  },
  {
    key: 'figma',
    label: 'Figma',
    website: 'https://figma.com',
    category: 'Design',
    adminOnly: true,
    description: 'Figma AI prompts by file, with credits used.',
    searchPlaceholder: 'Search prompts, people, files…',
    searchLabel: 'Search Figma prompts, people and files',
    Body: FigmaExplorerBody,
  },
];

export const RMW_TOOL_TABS_BY_KEY = Object.fromEntries(RMW_TOOL_TABS.map((tab) => [tab.key, tab]));
