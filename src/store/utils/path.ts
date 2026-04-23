const HOME = process.env.HOME || process.env.USERPROFILE || "/tmp";

export function homedir(): string {
  return HOME;
}

export function isAbsolutePath(path: string): boolean {
  if (!path) return false;
  
  if (path.startsWith('/')) {
    if (!isWSL() && path.length >= 3 && path[2] === '/') {
      const driveLetter = path[1];
      if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
        return true;
      }
    }
    return true;
  }
  
  if (path.length >= 2 && /[a-zA-Z]/.test(path[0]!) && path[1] === ':') {
    return true;
  }
  
  return false;
}

export function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

function isWSL(): boolean {
  return !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

export function getRelativePathFromPrefix(path: string, prefix: string): string | null {
  if (!prefix) {
    return null;
  }
  
  const normalizedPath = normalizePathSeparators(path);
  const normalizedPrefix = normalizePathSeparators(prefix);
  
  const prefixWithSlash = !normalizedPrefix.endsWith('/') 
    ? normalizedPrefix + '/' 
    : normalizedPrefix;
  
  if (normalizedPath === normalizedPrefix) {
    return '';
  }
  
  if (normalizedPath.startsWith(prefixWithSlash)) {
    return normalizedPath.slice(prefixWithSlash.length);
  }
  
  return null;
}

export function resolve(...paths: string[]): string {
  if (paths.length === 0) {
    throw new Error("resolve: at least one path segment is required");
  }
  
  const normalizedPaths = paths.map(normalizePathSeparators);
  
  let result = '';
  let windowsDrive = '';
  
  const firstPath = normalizedPaths[0]!;
  if (isAbsolutePath(firstPath)) {
    result = firstPath;
    
    if (firstPath.length >= 2 && /[a-zA-Z]/.test(firstPath[0]!) && firstPath[1] === ':') {
      windowsDrive = firstPath.slice(0, 2);
      result = firstPath.slice(2);
    } else if (!isWSL() && firstPath.startsWith('/') && firstPath.length >= 3 && firstPath[2] === '/') {
      const driveLetter = firstPath[1];
      if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
        windowsDrive = driveLetter.toUpperCase() + ':';
        result = firstPath.slice(2);
      }
    }
  } else {
    const pwd = normalizePathSeparators(process.env.PWD || process.cwd());
    
    if (pwd.length >= 2 && /[a-zA-Z]/.test(pwd[0]!) && pwd[1] === ':') {
      windowsDrive = pwd.slice(0, 2);
      result = pwd.slice(2) + '/' + firstPath;
    } else {
      result = pwd + '/' + firstPath;
    }
  }
  
  for (let i = 1; i < normalizedPaths.length; i++) {
    const p = normalizedPaths[i]!;
    if (isAbsolutePath(p)) {
      result = p;
      
      if (p.length >= 2 && /[a-zA-Z]/.test(p[0]!) && p[1] === ':') {
        windowsDrive = p.slice(0, 2);
        result = p.slice(2);
      } else if (!isWSL() && p.startsWith('/') && p.length >= 3 && p[2] === '/') {
        const driveLetter = p[1];
        if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
          windowsDrive = driveLetter.toUpperCase() + ':';
          result = p.slice(2);
        } else {
          windowsDrive = '';
        }
      } else {
        windowsDrive = '';
      }
    } else {
      result = result + '/' + p;
    }
  }
  
  const parts = result.split('/').filter(Boolean);
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      normalized.pop();
    } else if (part !== '.') {
      normalized.push(part);
    }
  }
  
  const finalPath = '/' + normalized.join('/');
  
  if (windowsDrive) {
    return windowsDrive + finalPath;
  }
  
  return finalPath;
}
