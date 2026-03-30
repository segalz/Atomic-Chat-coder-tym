import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { DependencyTreeView } from './DependencyTreeView'
import { ProjectDnaCard } from './ProjectDnaCard'
import { ContextPreview } from './ContextPreview'
import { useProjectModeStore } from '@/stores/project-mode-store'
import { route } from '@/constants/routes'
import { IconFolderOpen, IconFileCode, IconScan, IconBulb, IconCamera, IconLanguage } from '@tabler/icons-react'

export function ProjectModePanel() {
  const { t } = useTranslation()
  const {
    projectRoot,
    entryFile,
    dependencyTree,
    projectDna,
    bundledContext,
    isAnalyzing,
    error,
    setProjectRoot,
    setEntryFile,
    analyzeProject,
  } = useProjectModeStore()

  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<'tree' | 'dna' | 'context'>('tree')

  const handleSelectFolder = async () => {
    try {
      const selected = await invoke<string | null>('open_dialog', {
        options: { directory: true, title: t('common:selectProjectFolder') },
      })
      if (selected) {
        setProjectRoot(selected)
      }
    } catch (err) {
      console.error('Failed to open folder dialog:', err)
    }
  }

  const handleSelectEntry = async () => {
    try {
      const selected = await invoke<string | null>('open_dialog', {
        options: {
          directory: false,
          multiple: false,
          title: t('common:selectEntryFile'),
          filters: [
            {
              name: 'Source Files',
              extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'cs', 'rs'],
            },
          ],
          defaultPath: projectRoot || undefined,
        },
      })
      if (selected) {
        setEntryFile(selected)
      }
    } catch (err) {
      console.error('Failed to open file dialog:', err)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-6 py-4">
        <h1 className="text-lg font-semibold">{t('common:projectMode')}</h1>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b px-6 py-3">
        <Button
          variant="outline"
          size="sm"
          onClick={handleSelectFolder}
          className="gap-2"
        >
          <IconFolderOpen size={16} />
          {projectRoot
            ? projectRoot.split('/').pop()
            : t('common:selectProjectFolder')}
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={handleSelectEntry}
          disabled={!projectRoot}
          className="gap-2"
        >
          <IconFileCode size={16} />
          {entryFile
            ? entryFile.split('/').pop()
            : t('common:selectEntryFile')}
        </Button>

        <Button
          variant="default"
          size="sm"
          onClick={analyzeProject}
          disabled={!projectRoot || !entryFile || isAnalyzing}
          className="gap-2"
        >
          <IconScan size={16} />
          {isAnalyzing ? t('common:analyzing') : t('common:analyze')}
        </Button>

        <div className="mx-1 h-6 w-px bg-border" />

        <Button
          variant="secondary"
          size="sm"
          onClick={() => navigate({ to: route.projectMode.plan })}
          className="gap-2"
        >
          <IconBulb size={16} />
          {t('common:planByAi')}
        </Button>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => navigate({ to: route.projectMode.vision })}
          className="gap-2"
        >
          <IconCamera size={16} />
          {t('common:vision')}
        </Button>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => navigate({ to: route.projectMode.translation })}
          className="gap-2"
        >
          <IconLanguage size={16} />
          Translation
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-6 mt-3 rounded-md bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Tabs */}
      {dependencyTree && (
        <div className="flex border-b px-6">
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'tree'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab('tree')}
          >
            {t('common:dependencyTree')}
          </button>
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'dna'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab('dna')}
          >
            {t('common:projectDna')}
          </button>
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'context'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab('context')}
          >
            {t('common:exportContext')}
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {!dependencyTree && !isAnalyzing && (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <div className="text-center">
              <IconFolderOpen size={48} className="mx-auto mb-4 opacity-30" />
              <p className="text-lg font-medium">{t('common:projectMode')}</p>
              <p className="mt-1 text-sm">
                {t('common:selectProjectFolder')} &rarr; {t('common:selectEntryFile')} &rarr; {t('common:analyze')}
              </p>
            </div>
          </div>
        )}

        {isAnalyzing && (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="mx-auto mb-4 size-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
              <p className="text-sm text-muted-foreground">{t('common:analyzing')}</p>
            </div>
          </div>
        )}

        {dependencyTree && !isAnalyzing && (
          <>
            {activeTab === 'tree' && <DependencyTreeView tree={dependencyTree} />}
            {activeTab === 'dna' && projectDna && <ProjectDnaCard dna={projectDna} />}
            {activeTab === 'context' && bundledContext && <ContextPreview context={bundledContext} />}
          </>
        )}
      </div>
    </div>
  )
}
