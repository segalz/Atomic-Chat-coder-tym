import { describe, expect, it } from 'vitest'
import { isRtlText } from '@/utils/textDirection'
import {
  CLINE_FREE_MODELS,
  resolveSelectedClineModel,
  CODING_AGENT_CLINE_MODEL_STORAGE_KEY,
} from './backend-identity'
import { buildCodingAgentPrompt } from './conversation-context'
import type { CodingSession } from '@/stores/coding-agent-store'

describe('Transparent Model-Switch Auto-Continuation', () => {
  describe('Language and RTL detection for continuation prompt', () => {
    it('detects Hebrew in previous turns and selects Hebrew continuation prompt', () => {
      const hebrewLog = [
        'תבדוק את הקוד ותריץ בדיקות',
        'הרצתי את הבדיקות והכל עבר בהצלחה.',
      ].join(' ')

      expect(isRtlText(hebrewLog)).toBe(true)

      const continuationPrompt = isRtlText(hebrewLog)
        ? 'המשך את השיחה והמשימה מאותה נקודה עם המודל החדש.'
        : 'Continue the conversation and task from this point with the newly selected model.'

      expect(continuationPrompt).toBe('המשך את השיחה והמשימה מאותה נקודה עם המודל החדש.')
    })

    it('detects English in previous turns and selects English continuation prompt', () => {
      const englishLog = [
        'Please inspect the project structure and build files.',
        'Done! Found package.json and vite.config.ts.',
      ].join(' ')

      expect(isRtlText(englishLog)).toBe(false)

      const continuationPrompt = isRtlText(englishLog)
        ? 'המשך את השיחה והמשימה מאותה נקודה עם המודל החדש.'
        : 'Continue the conversation and task from this point with the newly selected model.'

      expect(continuationPrompt).toBe('Continue the conversation and task from this point with the newly selected model.')
    })

    it('detects Hebrew when previous prompt was Hebrew but recent tool logs are English', () => {
      const sessionPrompt = 'תבדוק את הקוד ותריץ בדיקות'
      const englishToolLogs = [
        'python -m unittest discover',
        'Ran 12 tests in 0.45s',
        'OK',
      ]
      const combinedText = [sessionPrompt, ...englishToolLogs].filter(Boolean).join(' ')
      expect(isRtlText(combinedText)).toBe(true)
    })
  })

  describe('Model display name resolution', () => {
    it('resolves official Cline free model IDs to user-friendly display names', () => {
      const glm = CLINE_FREE_MODELS.find((m) => m.id === 'zai/glm-5.3-flash')
      expect(glm?.name).toBe('GLM 5.3 Flash')

      const deepseek = CLINE_FREE_MODELS.find(
        (m) => m.id === 'deepseek/deepseek-v4-flash'
      )
      expect(deepseek?.name).toBe('DeepSeek V4 Flash')

      const laguna = CLINE_FREE_MODELS.find(
        (m) => m.id === 'poolside/laguna-s-2.1:free'
      )
      expect(laguna?.name).toBe('Laguna S 2.1')

      const muse = CLINE_FREE_MODELS.find(
        (m) => m.id === 'meta/muse-spark-1.2-contributor'
      )
      expect(muse?.name).toBe('Muse Spark 1.3 Contributor')

      const solar = CLINE_FREE_MODELS.find(
        (m) => m.id === 'upstage/solar-pro4'
      )
      expect(solar?.name).toBe('Solar Pro 4')

      const longcat = CLINE_FREE_MODELS.find(
        (m) => m.id === 'meituan/longcat-2.0'
      )
      expect(longcat?.name).toBe('LongCat 2.0')

      // Unknown/fallback model returns the ID itself
      const unknownId = 'custom/unknown-model'
      const resolved =
        CLINE_FREE_MODELS.find((m) => m.id === unknownId)?.name ?? unknownId
      expect(resolved).toBe('custom/unknown-model')
    })
  })

  describe('Context preservation during continuation', () => {
    const activeSession: CodingSession = {
      id: 'session-123',
      prompt: 'בדוק את הקבצים בפרויקט',
      source: 'manual',
      backend: 'cline-acp',
      externalSessionId: 'acp-ext-456',
      projectDir: 'C:\\Develop\\traidAi',
      planText: 'תוכנית בדיקה',
      execLog: [
        { type: 'text_delta', content: 'בדקתי את קובץ ה-DB', timestamp: 100 },
        { type: 'text_delta', content: 'python -m taide.calibration', timestamp: 200 },
      ],
      pendingDiffs: [],
      timestamp: 100,
    }

    it('injects full conversational history during Cline continuation turns', () => {
      const prompt = 'המשך את השיחה והמשימה מאותה נקודה עם המודל החדש.'
      const promptForAgent = buildCodingAgentPrompt({
        prompt,
        projectDir: 'C:\\Develop\\traidAi',
        sessions: [activeSession],
        activeSessionId: 'session-123',
        backend: 'cline-acp',
        source: 'manual',
        isContinuation: true,
        includeHistory: true,
        includeSummaryContext: true,
      })

      expect(promptForAgent).toContain('Current conversation so far:')
      expect(promptForAgent).toContain('בדקתי את קובץ ה-DB')
      expect(promptForAgent).toContain('Current request:')
      expect(promptForAgent).toContain(prompt)
    })

    it('injects full conversational history when switching models in Ollama backend', () => {
      const ollamaActiveSession: CodingSession = {
        ...activeSession,
        backend: 'direct-ollama',
        externalSessionId: undefined,
      }

      const prompt = 'המשך את השיחה והמשימה מאותה נקודה עם המודל החדש.'
      const promptForAgent = buildCodingAgentPrompt({
        prompt,
        projectDir: 'C:\\Develop\\traidAi',
        sessions: [ollamaActiveSession],
        activeSessionId: 'session-123',
        backend: 'direct-ollama',
        source: 'manual',
        isContinuation: false,
        includeHistory: true,
        includeSummaryContext: true,
      })

      expect(promptForAgent).toContain('בדקתי את קובץ ה-DB')
      expect(promptForAgent).toContain('Current request:')
      expect(promptForAgent).toContain(prompt)
    })
  })

  describe('Legacy Cline model migration', () => {
    it('migrates older model ids stored in localStorage to valid Cline catalog ids', () => {
      window.localStorage.setItem(CODING_AGENT_CLINE_MODEL_STORAGE_KEY, 'z-ai/glm-5.3-flash')
      expect(resolveSelectedClineModel()).toBe('zai/glm-5.3-flash')

      window.localStorage.setItem(CODING_AGENT_CLINE_MODEL_STORAGE_KEY, 'cline-free/longcat-2.0')
      expect(resolveSelectedClineModel()).toBe('meituan/longcat-2.0')

      window.localStorage.setItem(CODING_AGENT_CLINE_MODEL_STORAGE_KEY, 'meituan/longcat-2.0')
      expect(resolveSelectedClineModel()).toBe('meituan/longcat-2.0')

      window.localStorage.setItem(CODING_AGENT_CLINE_MODEL_STORAGE_KEY, 'cline-free/solar-pro4')
      expect(resolveSelectedClineModel()).toBe('upstage/solar-pro4')

      window.localStorage.setItem(CODING_AGENT_CLINE_MODEL_STORAGE_KEY, 'upstage/solar-pro4')
      expect(resolveSelectedClineModel()).toBe('upstage/solar-pro4')

      window.localStorage.setItem(
        CODING_AGENT_CLINE_MODEL_STORAGE_KEY,
        'cline-free/muse-spark-1.3-contributor'
      )
      expect(resolveSelectedClineModel()).toBe('meta/muse-spark-1.2-contributor')

      window.localStorage.setItem(
        CODING_AGENT_CLINE_MODEL_STORAGE_KEY,
        'meta/muse-spark-1.3-contributor'
      )
      expect(resolveSelectedClineModel()).toBe('meta/muse-spark-1.2-contributor')

      window.localStorage.setItem(
        CODING_AGENT_CLINE_MODEL_STORAGE_KEY,
        'meta/muse-spark-1.2-contributor'
      )
      expect(resolveSelectedClineModel()).toBe('meta/muse-spark-1.2-contributor')

      // An unrecognized model falls back to default
      window.localStorage.setItem(CODING_AGENT_CLINE_MODEL_STORAGE_KEY, 'totally-bogus-model')
      expect(resolveSelectedClineModel()).toBe('zai/glm-5.3-flash')
    })
  })
})
