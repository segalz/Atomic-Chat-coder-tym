export interface DependencyNode {
  absolutePath: string
  relativePath: string
  children: DependencyNode[]
  isExternal: boolean
  isUnresolved: boolean
}

export interface ProjectDna {
  projectRoot: string
  techStack: string[]
  folderGroups: FolderGroup[]
  namingConventions: string[]
}

export interface FolderGroup {
  relativePath: string
  componentType: string
  fileNames: string[]
}
