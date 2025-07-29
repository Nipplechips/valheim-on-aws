import * as path from 'path';
import * as fs from 'fs';
export function readAndTemplateFile(filePath: string, variables: Record<string, string>): string {
    const fullPath = path.join(__dirname, filePath);
    let content = fs.readFileSync(fullPath, 'utf8');

    Object.entries(variables).forEach(([key, value]) => {
      content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    });

    return content;
  }