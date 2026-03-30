import type { ProjectDna } from '@/types/pm/dependency-tree'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { IconCode, IconFolder, IconTag } from '@tabler/icons-react'

interface ProjectDnaCardProps {
  dna: ProjectDna
}

export function ProjectDnaCard({ dna }: ProjectDnaCardProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      {/* Tech Stack */}
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <IconCode size={16} />
          {t('common:techStack')}
        </h3>
        <div className="flex flex-wrap gap-2">
          {dna.techStack.map(tech => (
            <span
              key={tech}
              className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
            >
              {tech}
            </span>
          ))}
        </div>
      </section>

      {/* Naming Conventions */}
      {dna.namingConventions.length > 0 && (
        <section>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <IconTag size={16} />
            Naming Conventions
          </h3>
          <div className="flex flex-wrap gap-2">
            {dna.namingConventions.map(conv => (
              <span
                key={conv}
                className="rounded-full bg-accent px-3 py-1 text-xs text-accent-foreground"
              >
                {conv}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Folder Structure */}
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <IconFolder size={16} />
          {t('common:folderStructure')}
        </h3>
        <div className="space-y-2">
          {dna.folderGroups.map(group => (
            <div
              key={group.relativePath}
              className="rounded-lg border p-3"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-medium">{group.relativePath}</span>
                <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {group.componentType}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {group.fileNames.length <= 8
                  ? group.fileNames.join(', ')
                  : group.fileNames.slice(0, 6).join(', ') +
                    ` ... (+${group.fileNames.length - 6} more)`}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
