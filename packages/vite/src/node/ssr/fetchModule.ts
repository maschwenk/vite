import { pathToFileURL } from 'node:url'
import type { SourceMap } from 'rolldown'
import type { FetchResult } from 'vite/module-runner'
import type { EnvironmentModuleNode, TransformResult } from '..'
import {
  MODULE_RUNNER_SOURCEMAPPING_SOURCE,
  SOURCEMAPPING_URL,
} from '../../shared/constants'
import { encodeSourceURL, unwrapId } from '../../shared/utils'
import { tryNodeResolve } from '../plugins/resolve'
import type { DevEnvironment } from '../server/environment'
import { genSourceMapUrl } from '../server/sourcemap'
import { isBuiltin, isExternalUrl, isFilePathESM } from '../utils'

export interface FetchModuleOptions {
  cached?: boolean
  inlineSourceMap?: boolean
  separateSourceMap?: boolean
  startOffset?: number
}

/**
 * Fetch module information for Vite module runner.
 * @experimental
 */
export async function fetchModule(
  environment: DevEnvironment,
  url: string,
  importer?: string,
  options: FetchModuleOptions = {},
): Promise<FetchResult> {
  if (
    url.startsWith('data:') ||
    isBuiltin(environment.config.resolve.builtins, url)
  ) {
    return { externalize: url, type: 'builtin' }
  }

  // handle file urls from not statically analyzable dynamic import
  const isFileUrl = url.startsWith('file://')

  if (isExternalUrl(url) && !isFileUrl) {
    return { externalize: url, type: 'network' }
  }

  // if there is no importer, the file is an entry point
  // entry points are always internalized
  if (!isFileUrl && importer && url[0] !== '.' && url[0] !== '/') {
    const { isProduction, root } = environment.config
    const { externalConditions, dedupe, preserveSymlinks } =
      environment.config.resolve

    const resolved = tryNodeResolve(url, importer, {
      mainFields: ['main'],
      conditions: externalConditions,
      externalConditions,
      external: [],
      noExternal: [],
      extensions: ['.js', '.cjs', '.json'],
      dedupe,
      preserveSymlinks,
      tsconfigPaths: false,
      isBuild: false,
      isProduction,
      root,
      packageCache: environment.config.packageCache,
      builtins: environment.config.resolve.builtins,
    })
    if (!resolved) {
      const err: any = new Error(
        `Cannot find module '${url}' imported from '${importer}'`,
      )
      err.code = 'ERR_MODULE_NOT_FOUND'
      throw err
    }
    const file = pathToFileURL(resolved.id).toString()
    const type = isFilePathESM(resolved.id, environment.config.packageCache)
      ? 'module'
      : 'commonjs'
    return { externalize: file, type }
  }

  url = unwrapId(url)

  const mod = await environment.moduleGraph.ensureEntryFromUrl(url)
  const cached = !!mod.transformResult

  // if url is already cached, we can just confirm it's also cached on the server
  if (options.cached && cached) {
    return { cache: true }
  }

  let result = await environment.transformRequest(url)

  if (!result) {
    throw new Error(
      `[vite] transform failed for module '${url}'${
        importer ? ` imported from '${importer}'` : ''
      }.`,
    )
  }

  const separate =
    options.inlineSourceMap !== false && !!options.separateSourceMap

  if (options.inlineSourceMap !== false && !separate) {
    result = inlineSourceMap(mod, result, options.startOffset)
  }

  // remove shebang
  if (result.code[0] === '#')
    result.code = result.code.replace(/^#!.*/, (s) => ' '.repeat(s.length))

  const { code, map } = separate
    ? separateSourceMap(mod, result, options.startOffset)
    : { code: result.code, map: undefined }

  return {
    code,
    file: mod.file,
    id: mod.id!,
    url: mod.url,
    invalidate: !cached,
    ...(map && { map }),
  }
}

const OTHER_SOURCE_MAP_REGEXP = new RegExp(
  `//# ${SOURCEMAPPING_URL}=data:application/json[^,]+base64,([A-Za-z0-9+/=]+)$`,
  'gm',
)

function inlineSourceMap(
  mod: EnvironmentModuleNode,
  result: TransformResult,
  startOffset: number | undefined,
) {
  const map = result.map

  if (
    !map ||
    !('version' in map) ||
    result.code.includes(MODULE_RUNNER_SOURCEMAPPING_SOURCE)
  )
    return result

  result.code = `${withSourceURL(mod, result.code)}${MODULE_RUNNER_SOURCEMAPPING_SOURCE}\n//# ${SOURCEMAPPING_URL}=${genSourceMapUrl(offsetSourceMap(map, startOffset))}\n`

  return result
}

// Unlike `inlineSourceMap`, this doesn't write to `result`: the transform
// result is shared with runners that still want the map inlined
function separateSourceMap(
  mod: EnvironmentModuleNode,
  result: TransformResult,
  startOffset: number | undefined,
): { code: string; map?: SourceMap } {
  const map = result.map
  if (!map || !('version' in map)) return { code: result.code }

  // a runner with inline maps fetched this transform result first, so the
  // code already ends with the sourceURL and the trailer `inlineSourceMap` wrote
  const code = result.code
  const trailer = code.lastIndexOf(INLINED_MAP_PREFIX)
  const isInlined =
    trailer !== -1 &&
    code.indexOf('\n', trailer + INLINED_MAP_PREFIX.length) === code.length - 1

  return {
    code: isInlined ? code.slice(0, trailer) : withSourceURL(mod, code),
    map: offsetSourceMap(map, startOffset),
  }
}

const INLINED_MAP_PREFIX = `${MODULE_RUNNER_SOURCEMAPPING_SOURCE}\n//# ${SOURCEMAPPING_URL}=`

function withSourceURL(mod: EnvironmentModuleNode, code: string) {
  // to reduce the payload size, we only keep vite node source map, because it's also the only one we use
  OTHER_SOURCE_MAP_REGEXP.lastIndex = 0
  if (OTHER_SOURCE_MAP_REGEXP.test(code))
    code = code.replace(OTHER_SOURCE_MAP_REGEXP, '')

  return `${code.trimEnd()}\n//# sourceURL=${encodeSourceURL(mod.id!)}\n`
}

function offsetSourceMap(map: SourceMap, startOffset: number | undefined) {
  return startOffset
    ? { ...map, mappings: ';'.repeat(startOffset) + map.mappings }
    : map
}
