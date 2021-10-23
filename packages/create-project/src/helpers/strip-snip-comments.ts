import glob from 'glob'
import path from 'path'
import { readFileSync, writeFileSync } from 'fs'

export function stripSnipComments(root: string) {
  const files = glob.sync('**/*.ts', {cwd: root})
  files.forEach(file => {
    const filePath = path.join(root, file)
    const fileString = readFileSync(filePath, 'utf8')
    writeFileSync(filePath, fileString.replace(/ *\/\/ @@@SNIP.+\n/g, ''))
  })
}