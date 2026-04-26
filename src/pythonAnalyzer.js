const vscode = require('vscode');
const path = require('path');

const EXCLUDE_GLOB = '**/{.git,__pycache__,.venv,venv,node_modules,dist,build,.mypy_cache,.pytest_cache}/**';
const KEYWORDS = new Set([
  'if',
  'elif',
  'else',
  'for',
  'while',
  'return',
  'yield',
  'raise',
  'with',
  'except',
  'print',
  'assert',
  'lambda',
  'and',
  'or',
  'not',
  'in',
  'is',
  'def',
  'class'
]);
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

async function analyzeWorkspace() {
  const files = await vscode.workspace.findFiles('**/*.py', EXCLUDE_GLOB);
  const nodes = [];
  const edges = [];
  const nodeById = new Map();
  const fileInfos = [];
  const fileByPath = new Map();
  const pendingCalls = [];
  const functionsByName = new Map();
  const methodsByName = new Map();
  const classesByName = new Map();
  const methodsByClass = new Map();
  const symbolsByModule = new Map();
  const fileByModule = new Map();

  for (const uri of files) {
    const contentBuffer = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(contentBuffer).toString('utf8');
    const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    const moduleName = toModuleName(relativePath);
    const fileNode = createNode({
      id: `file:${relativePath}`,
      label: path.basename(relativePath),
      kind: 'file',
      filePath: uri.fsPath,
      relativePath,
      line: 1,
      signature: moduleName,
      parentId: null,
      qualifiedName: moduleName,
      docstring: extractModuleDocstring(text),
      decorators: []
    });

    nodes.push(fileNode);
    nodeById.set(fileNode.id, fileNode);

    const info = {
      uri,
      filePath: uri.fsPath,
      relativePath,
      moduleName,
      isPackage: relativePath.endsWith('/__init__.py') || relativePath === '__init__.py',
      fileNodeId: fileNode.id,
      text,
      imports: new Map(),
      localFunctions: new Map(),
      localClasses: new Map(),
      localMethodsByClassName: new Map(),
      flags: {
        hasMainBlock: false,
        usesArgparse: false,
        usesClick: false,
        usesTyper: false,
        usesCelery: false,
        usesFastApi: false,
        usesFlask: false
      },
      entryCandidates: [],
      mainBlockCalls: []
    };

    fileInfos.push(info);
    fileByPath.set(info.filePath, info);
    fileByModule.set(moduleName, info);
    symbolsByModule.set(moduleName, {
      fileNodeId: fileNode.id,
      functions: new Map(),
      classes: new Map(),
      methodsByClassName: new Map()
    });
  }

  for (const info of fileInfos) {
    scanPythonFile(info, {
      nodes,
      edges,
      nodeById,
      pendingCalls,
      functionsByName,
      methodsByName,
      classesByName,
      methodsByClass,
      symbolsByModule
    });
  }

  for (const info of fileInfos) {
    resolveInternalImports(info, fileByModule, symbolsByModule);
    addImportEdges(info, edges);
  }

  for (const call of pendingCalls) {
    const targetId = resolveCall(call, {
      fileByPath,
      nodeById,
      functionsByName,
      methodsByName,
      classesByName,
      methodsByClass,
      symbolsByModule
    });
    if (!targetId || targetId === call.callerId) {
      continue;
    }

    edges.push({
      id: `calls:${call.callerId}:${targetId}:${call.line}:${call.expr}`,
      source: call.callerId,
      target: targetId,
      kind: 'calls',
      line: call.line,
      filePath: call.filePath,
      label: call.expr
    });
  }

  dedupeEdges(edges);

  const insights = buildInsights({
    nodes,
    edges,
    nodeById,
    fileInfos,
    fileByPath,
    functionsByName,
    methodsByName,
    classesByName,
    methodsByClass,
    symbolsByModule
  });

  return {
    nodes,
    edges,
    insights,
    stats: {
      files: fileInfos.length,
      nodes: nodes.length,
      edges: edges.length,
      entryPoints: insights.entryPoints.length,
      criticalPaths: insights.criticalPaths.length,
      hotspots: insights.hotspots.length
    }
  };
}

function scanPythonFile(info, ctx) {
  const lines = info.text.split(/\r?\n/);
  const stack = [{ indent: -1, nodeId: info.fileNodeId, kind: 'file', qualifiedName: info.moduleName }];
  const moduleSymbols = ctx.symbolsByModule.get(info.moduleName);
  let pendingDecorators = [];
  let mainBlockIndent = null;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const indent = getIndent(rawLine);

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    if (mainBlockIndent !== null && indent <= mainBlockIndent) {
      mainBlockIndent = null;
    }

    if (trimmed.startsWith('@')) {
      pendingDecorators.push({ text: trimmed, line: index + 1 });
      continue;
    }

    const fromImportMatch = trimmed.match(/^from\s+([\.\w]+)\s+import\s+(.+)$/);
    if (fromImportMatch) {
      const importSource = fromImportMatch[1];
      const importedNames = splitImportSpec(fromImportMatch[2]);
      const resolvedModule = resolveImportSource(importSource, info.moduleName, info.isPackage);
      for (const imported of importedNames) {
        const aliasMatch = imported.match(/^([A-Za-z_][\w]*)\s+as\s+([A-Za-z_][\w]*)$/);
        const symbolName = aliasMatch ? aliasMatch[1] : imported;
        const alias = aliasMatch ? aliasMatch[2] : symbolName;
        info.imports.set(alias, {
          kind: 'symbol',
          moduleName: resolvedModule,
          symbolName,
          sourceText: importSource
        });
      }
      applyImportFlags(info.flags, `${importSource} ${fromImportMatch[2]}`);
      pendingDecorators = [];
      continue;
    }

    const importMatch = trimmed.match(/^import\s+(.+)$/);
    if (importMatch) {
      const importedModules = splitImportSpec(importMatch[1]);
      for (const imported of importedModules) {
        const aliasMatch = imported.match(/^([A-Za-z_][\w\.]+)\s+as\s+([A-Za-z_][\w]*)$/);
        const moduleName = aliasMatch ? aliasMatch[1] : imported;
        const alias = aliasMatch ? aliasMatch[2] : moduleName.split('.').pop();
        info.imports.set(alias, {
          kind: 'module',
          moduleName,
          sourceText: moduleName
        });
        applyImportFlags(info.flags, moduleName);
      }
      pendingDecorators = [];
      continue;
    }

    if (/^if\s+__name__\s*==\s*['"]__main__['"]\s*:/.test(trimmed)) {
      info.flags.hasMainBlock = true;
      mainBlockIndent = indent;
      pendingDecorators = [];
      continue;
    }

    const classMatch = trimmed.match(/^class\s+([A-Za-z_][\w]*)\s*(\(|:)/);
    if (classMatch) {
      const className = classMatch[1];
      const parent = stack[stack.length - 1];
      const qualifiedName = parent.kind === 'class' ? `${parent.qualifiedName}.${className}` : className;
      const docstring = extractBlockDocstring(lines, index, indent);
      const node = createNode({
        id: `class:${info.relativePath}:${qualifiedName}:${index + 1}`,
        label: className,
        kind: 'class',
        filePath: info.filePath,
        relativePath: info.relativePath,
        line: index + 1,
        signature: trimmed,
        parentId: parent.nodeId,
        qualifiedName,
        decorators: pendingDecorators.map((decorator) => decorator.text),
        docstring
      });

      ctx.nodes.push(node);
      ctx.nodeById.set(node.id, node);
      ctx.edges.push(createContainsEdge(parent.nodeId, node.id));
      stack.push({ indent, nodeId: node.id, kind: 'class', qualifiedName, classNodeId: node.id, className });

      info.localClasses.set(className, node.id);
      moduleSymbols.classes.set(className, node.id);
      pushToMapArray(ctx.classesByName, className, node.id);
      pendingDecorators = [];
      continue;
    }

    const functionMatch = trimmed.match(/^(async\s+)?def\s+([A-Za-z_][\w]*)\s*\((.*)\)\s*:/);
    if (functionMatch) {
      const functionName = functionMatch[2];
      const parent = stack[stack.length - 1];
      const isMethod = parent.kind === 'class';
      const qualifiedName = isMethod ? `${parent.qualifiedName}.${functionName}` : functionName;
      const decorators = pendingDecorators.map((decorator) => decorator.text);
      const docstring = extractBlockDocstring(lines, index, indent);
      const entryMeta = detectEntryMetadata({
        decorators,
        functionName,
        relativePath: info.relativePath,
        flags: info.flags,
        isMethod
      });
      const node = createNode({
        id: `${isMethod ? 'method' : 'function'}:${info.relativePath}:${qualifiedName}:${index + 1}`,
        label: functionName,
        kind: isMethod ? 'method' : 'function',
        filePath: info.filePath,
        relativePath: info.relativePath,
        line: index + 1,
        signature: trimmed,
        parentId: parent.nodeId,
        parentClassId: isMethod ? parent.nodeId : null,
        qualifiedName,
        decorators,
        docstring,
        entryCategory: entryMeta ? entryMeta.category : null,
        entryLabel: entryMeta ? entryMeta.label : null,
        entryReason: entryMeta ? entryMeta.reason : null,
        entryRoute: entryMeta ? entryMeta.route : null
      });

      ctx.nodes.push(node);
      ctx.nodeById.set(node.id, node);
      ctx.edges.push(createContainsEdge(parent.nodeId, node.id));
      stack.push({
        indent,
        nodeId: node.id,
        kind: isMethod ? 'method' : 'function',
        qualifiedName,
        classNodeId: isMethod ? parent.nodeId : null,
        className: isMethod ? parent.className : null
      });

      if (isMethod) {
        const key = `${parent.nodeId}::${functionName}`;
        ctx.methodsByClass.set(key, node.id);
        pushToMapArray(ctx.methodsByName, functionName, node.id);
        setNestedMapValue(info.localMethodsByClassName, parent.className, functionName, node.id);
        setNestedMapValue(moduleSymbols.methodsByClassName, parent.className, functionName, node.id);
      } else {
        info.localFunctions.set(functionName, node.id);
        moduleSymbols.functions.set(functionName, node.id);
        pushToMapArray(ctx.functionsByName, functionName, node.id);
      }

      if (entryMeta) {
        info.entryCandidates.push({
          nodeId: node.id,
          category: entryMeta.category,
          label: entryMeta.label,
          reason: entryMeta.reason,
          route: entryMeta.route,
          line: index + 1
        });
      }

      pendingDecorators = [];
      continue;
    }

    const callerScope = [...stack].reverse().find((entry) => entry.kind === 'function' || entry.kind === 'method');
    if (callerScope) {
      const matches = findCallExpressions(trimmed);
      for (const expr of matches) {
        ctx.pendingCalls.push({
          callerId: callerScope.nodeId,
          expr,
          filePath: info.filePath,
          relativePath: info.relativePath,
          line: index + 1
        });
      }
      pendingDecorators = [];
      continue;
    }

    if (mainBlockIndent !== null && indent > mainBlockIndent) {
      const matches = findCallExpressions(trimmed);
      for (const expr of matches) {
        info.mainBlockCalls.push({ expr, line: index + 1 });
      }
    }

    pendingDecorators = [];
  }
}

function buildInsights(ctx) {
  const { nodes, edges, nodeById, fileInfos } = ctx;
  const callAdj = buildAdjacency(edges, ['calls']);
  const semanticAdj = buildAdjacency(edges, ['calls', 'imports']);
  const semanticReverseAdj = buildAdjacency(edges, ['calls', 'imports'], true);
  const callReverseAdj = buildAdjacency(edges, ['calls'], true);
  const degree = computeDegrees(edges);

  const entryPointMap = new Map();

  for (const info of fileInfos) {
    for (const candidate of info.entryCandidates) {
      upsertEntryPoint(entryPointMap, nodeById.get(candidate.nodeId), {
        category: candidate.category,
        label: candidate.label,
        reason: candidate.reason,
        route: candidate.route,
        priority: entryPriority(candidate.category)
      });
    }

    if (info.flags.hasMainBlock) {
      let resolved = false;
      for (const mainCall of info.mainBlockCalls) {
        const targetId = resolveCallExpression(mainCall.expr, info, null, ctx);
        const targetNode = targetId ? nodeById.get(targetId) : null;
        if (!targetNode) {
          continue;
        }
        resolved = true;
        upsertEntryPoint(entryPointMap, targetNode, {
          category: 'script',
          label: 'Script entry',
          reason: `Executed from ${path.basename(info.relativePath)} via __main__ block`,
          route: null,
          priority: 90
        });
      }

      if (!resolved) {
        const fileNode = nodeById.get(info.fileNodeId);
        upsertEntryPoint(entryPointMap, fileNode, {
          category: 'script',
          label: 'Script entry',
          reason: `Top-level executable file with __main__ block`,
          route: null,
          priority: 70
        });
      }
    }
  }

  const entryPoints = [...entryPointMap.values()]
    .filter(Boolean)
    .sort((a, b) => (b.priority - a.priority) || a.label.localeCompare(b.label))
    .slice(0, 10);

  for (const entryPoint of entryPoints) {
    const node = nodeById.get(entryPoint.id);
    if (node) {
      node.isEntryPoint = true;
      node.entryCategory = entryPoint.category;
      node.entryReason = entryPoint.reason;
      node.entryLabel = entryPoint.entryLabel;
      node.entryRoute = entryPoint.route || null;
    }
  }

  const hotspots = nodes
    .map((node) => {
      const metrics = degree.get(node.id) || { incoming: 0, outgoing: 0, incomingCalls: 0, outgoingCalls: 0, imports: 0 };
      const score = (metrics.incomingCalls * 5) + (metrics.outgoingCalls * 2) + (metrics.incoming * 1.5) + metrics.imports;
      const reasons = [];
      if (metrics.incomingCalls > 0) {
        reasons.push(`${metrics.incomingCalls} incoming call${metrics.incomingCalls === 1 ? '' : 's'}`);
      }
      if (metrics.outgoingCalls > 0) {
        reasons.push(`${metrics.outgoingCalls} downstream call${metrics.outgoingCalls === 1 ? '' : 's'}`);
      }
      if (metrics.imports > 0) {
        reasons.push(`${metrics.imports} import link${metrics.imports === 1 ? '' : 's'}`);
      }
      return {
        id: node.id,
        label: node.label,
        kind: node.kind,
        relativePath: node.relativePath,
        line: node.line,
        score,
        reasons,
        metrics
      };
    })
    .filter((item) => item.kind !== 'file' || item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const hotspotIds = new Set(hotspots.map((item) => item.id));
  for (const node of nodes) {
    node.isHotspot = hotspotIds.has(node.id);
  }

  const criticalPaths = entryPoints
    .map((entryPoint) => {
      const pathIds = findBestPath(entryPoint.id, callAdj, nodeById, 5);
      const pathNodes = pathIds.map((id) => nodeById.get(id)).filter(Boolean);
      return {
        id: `path:${entryPoint.id}`,
        entryId: entryPoint.id,
        title: entryPoint.route || entryPoint.entryLabel || entryPoint.label,
        subtitle: entryPoint.reason,
        nodes: pathNodes.map((node) => ({
          id: node.id,
          label: node.label,
          kind: node.kind,
          relativePath: node.relativePath,
          line: node.line
        })),
        summary: summarizePath(pathNodes)
      };
    })
    .filter((pathInfo) => pathInfo.nodes.length > 0)
    .sort((a, b) => b.nodes.length - a.nodes.length)
    .slice(0, 8);

  return {
    entryPoints,
    criticalPaths,
    hotspots,
    graphHealth: {
      denseAreas: hotspots.length,
      totalSemanticEdges: edges.filter((edge) => edge.kind === 'calls' || edge.kind === 'imports').length
    },
    maps: {
      semanticAdj: serializeAdjacency(semanticAdj),
      semanticReverseAdj: serializeAdjacency(semanticReverseAdj),
      callAdj: serializeAdjacency(callAdj),
      callReverseAdj: serializeAdjacency(callReverseAdj)
    }
  };
}

function detectEntryMetadata({ decorators, functionName, relativePath, flags }) {
  for (const decorator of decorators) {
    const routeMeta = parseRouteDecorator(decorator);
    if (routeMeta) {
      return {
        category: 'route',
        label: `${routeMeta.method} ${routeMeta.path}`,
        reason: `HTTP route handler in ${path.basename(relativePath)}`,
        route: `${routeMeta.method} ${routeMeta.path}`
      };
    }

    if (/@.*\.(command|callback)\b|@click\.(command|group)\b|@app\.command\b|@cli\.command\b|@typer\.command\b/i.test(decorator)) {
      return {
        category: 'cli',
        label: `CLI: ${functionName}`,
        reason: 'Command-line entry point',
        route: null
      };
    }

    if (/@(shared_task|.+\.task)\b/i.test(decorator)) {
      return {
        category: 'task',
        label: `Task: ${functionName}`,
        reason: 'Background task entry point',
        route: null
      };
    }
  }

  if (functionName === 'main' && (flags.hasMainBlock || flags.usesArgparse || flags.usesClick || flags.usesTyper)) {
    return {
      category: 'script',
      label: 'Main function',
      reason: 'Primary executable function',
      route: null
    };
  }

  if ((/cli|command/i.test(relativePath) || flags.usesClick || flags.usesTyper) && /^(run|main|start)$/i.test(functionName)) {
    return {
      category: 'cli',
      label: `CLI: ${functionName}`,
      reason: 'Likely command entry point',
      route: null
    };
  }

  if ((flags.usesCelery || /worker|task|jobs?/i.test(relativePath)) && /task|job|worker|process/i.test(functionName)) {
    return {
      category: 'task',
      label: `Task: ${functionName}`,
      reason: 'Likely background job entry point',
      route: null
    };
  }

  return null;
}

function parseRouteDecorator(decorator) {
  const dotMethodMatch = decorator.match(new RegExp(`@.+\\.(${HTTP_METHODS.join('|')})\\(\\s*(["'])(.*?)\\2`, 'i'));
  if (dotMethodMatch) {
    return {
      method: dotMethodMatch[1].toUpperCase(),
      path: dotMethodMatch[3] || '/'
    };
  }

  const flaskRouteMatch = decorator.match(/@.+\.route\(\s*(["'])(.*?)\1(?:\s*,\s*methods\s*=\s*\[([^\]]+)\])?/i);
  if (flaskRouteMatch) {
    const methods = flaskRouteMatch[3]
      ? flaskRouteMatch[3].match(/["']([A-Za-z]+)["']/g) || []
      : ['"GET"'];
    const firstMethod = (methods[0] || '"GET"').replace(/["']/g, '').toUpperCase();
    return {
      method: firstMethod,
      path: flaskRouteMatch[2] || '/'
    };
  }

  return null;
}

function applyImportFlags(flags, importText) {
  const lower = String(importText || '').toLowerCase();
  if (lower.includes('argparse')) {
    flags.usesArgparse = true;
  }
  if (lower.includes('click')) {
    flags.usesClick = true;
  }
  if (lower.includes('typer')) {
    flags.usesTyper = true;
  }
  if (lower.includes('celery')) {
    flags.usesCelery = true;
  }
  if (lower.includes('fastapi')) {
    flags.usesFastApi = true;
  }
  if (lower.includes('flask')) {
    flags.usesFlask = true;
  }
}

function resolveInternalImports(info, fileByModule, symbolsByModule) {
  for (const imported of info.imports.values()) {
    if (imported.kind === 'module') {
      const moduleInfo = fileByModule.get(imported.moduleName);
      if (moduleInfo) {
        imported.internalTargetId = moduleInfo.fileNodeId;
      }
      continue;
    }

    const moduleSymbols = symbolsByModule.get(imported.moduleName);
    if (!moduleSymbols) {
      const moduleInfo = fileByModule.get(imported.moduleName);
      if (moduleInfo) {
        imported.internalTargetId = moduleInfo.fileNodeId;
      }
      continue;
    }

    imported.internalTargetId = moduleSymbols.functions.get(imported.symbolName)
      || moduleSymbols.classes.get(imported.symbolName)
      || moduleSymbols.fileNodeId;
  }
}

function addImportEdges(info, edges) {
  for (const [alias, imported] of info.imports.entries()) {
    if (!imported.internalTargetId) {
      continue;
    }

    edges.push({
      id: `imports:${info.fileNodeId}:${imported.internalTargetId}:${alias}`,
      source: info.fileNodeId,
      target: imported.internalTargetId,
      kind: 'imports',
      label: alias,
      filePath: info.filePath,
      line: 1
    });
  }
}

function resolveCall(call, ctx) {
  const callerNode = ctx.nodeById.get(call.callerId);
  if (!callerNode) {
    return null;
  }

  const fileInfo = ctx.fileByPath.get(callerNode.filePath);
  if (!fileInfo) {
    return null;
  }

  return resolveCallExpression(call.expr, fileInfo, callerNode, ctx);
}

function resolveCallExpression(expr, fileInfo, callerNode, ctx) {
  const segments = String(expr || '').split('.').filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  const bareName = segments[segments.length - 1];

  if (segments.length === 2 && callerNode && (segments[0] === 'self' || segments[0] === 'cls') && callerNode.parentClassId) {
    const sameClassMethod = ctx.methodsByClass.get(`${callerNode.parentClassId}::${segments[1]}`);
    if (sameClassMethod) {
      return sameClassMethod;
    }
  }

  const directImport = fileInfo.imports.get(segments[0]);
  if (directImport) {
    if (directImport.kind === 'symbol' && segments.length === 1 && directImport.internalTargetId) {
      return directImport.internalTargetId;
    }
    if (directImport.kind === 'module' && directImport.moduleName) {
      const target = resolveModuleMember(directImport.moduleName, segments.slice(1), bareName, ctx.symbolsByModule);
      if (target) {
        return target;
      }
      if (segments.length === 1 && directImport.internalTargetId) {
        return directImport.internalTargetId;
      }
    }
  }

  if (segments.length === 2) {
    const localClassId = fileInfo.localClasses.get(segments[0]);
    if (localClassId) {
      const methodId = getNestedMapValue(fileInfo.localMethodsByClassName, segments[0], segments[1]);
      if (methodId) {
        return methodId;
      }
    }
  }

  if (callerNode && callerNode.parentClassId) {
    const sameClassMethod = ctx.methodsByClass.get(`${callerNode.parentClassId}::${bareName}`);
    if (sameClassMethod) {
      return sameClassMethod;
    }
  }

  if (fileInfo.localFunctions.has(bareName)) {
    return fileInfo.localFunctions.get(bareName);
  }

  if (fileInfo.localClasses.has(bareName)) {
    return fileInfo.localClasses.get(bareName);
  }

  const importedBare = fileInfo.imports.get(bareName);
  if (importedBare && importedBare.internalTargetId) {
    return importedBare.internalTargetId;
  }

  const projectFunctions = ctx.functionsByName.get(bareName) || [];
  if (projectFunctions.length === 1) {
    return projectFunctions[0];
  }

  const projectMethods = ctx.methodsByName.get(bareName) || [];
  if (projectMethods.length === 1) {
    return projectMethods[0];
  }

  const projectClasses = ctx.classesByName.get(bareName) || [];
  if (projectClasses.length === 1) {
    return projectClasses[0];
  }

  return null;
}

function resolveModuleMember(moduleName, memberPath, bareName, symbolsByModule) {
  const moduleSymbols = symbolsByModule.get(moduleName);
  if (!moduleSymbols) {
    return null;
  }

  if (memberPath.length === 0) {
    return moduleSymbols.fileNodeId;
  }

  const firstMember = memberPath[0];
  if (moduleSymbols.functions.has(firstMember)) {
    return moduleSymbols.functions.get(firstMember);
  }
  if (moduleSymbols.classes.has(firstMember)) {
    return moduleSymbols.classes.get(firstMember);
  }

  if (memberPath.length >= 2) {
    return getNestedMapValue(moduleSymbols.methodsByClassName, memberPath[0], memberPath[1]);
  }

  if (bareName) {
    const uniqueMethod = getNestedMapValue(moduleSymbols.methodsByClassName, firstMember, bareName);
    if (uniqueMethod) {
      return uniqueMethod;
    }
  }

  return null;
}

function buildAdjacency(edges, kinds, reverse = false) {
  const allowedKinds = new Set(kinds);
  const map = new Map();
  for (const edge of edges) {
    if (!allowedKinds.has(edge.kind)) {
      continue;
    }
    const source = reverse ? edge.target : edge.source;
    const target = reverse ? edge.source : edge.target;
    if (!map.has(source)) {
      map.set(source, []);
    }
    map.get(source).push(target);
  }
  return map;
}

function computeDegrees(edges) {
  const map = new Map();
  for (const edge of edges) {
    if (!map.has(edge.source)) {
      map.set(edge.source, { incoming: 0, outgoing: 0, incomingCalls: 0, outgoingCalls: 0, imports: 0 });
    }
    if (!map.has(edge.target)) {
      map.set(edge.target, { incoming: 0, outgoing: 0, incomingCalls: 0, outgoingCalls: 0, imports: 0 });
    }

    map.get(edge.source).outgoing += 1;
    map.get(edge.target).incoming += 1;

    if (edge.kind === 'calls') {
      map.get(edge.source).outgoingCalls += 1;
      map.get(edge.target).incomingCalls += 1;
    }
    if (edge.kind === 'imports') {
      map.get(edge.source).imports += 1;
      map.get(edge.target).imports += 1;
    }
  }
  return map;
}

function upsertEntryPoint(entryPointMap, node, data) {
  if (!node) {
    return;
  }
  const existing = entryPointMap.get(node.id);
  const next = {
    id: node.id,
    label: node.label,
    kind: node.kind,
    relativePath: node.relativePath,
    line: node.line,
    category: data.category,
    entryLabel: data.label,
    reason: data.reason,
    route: data.route,
    priority: data.priority || 0
  };
  if (!existing || next.priority > existing.priority) {
    entryPointMap.set(node.id, next);
  }
}

function entryPriority(category) {
  switch (category) {
    case 'route': return 120;
    case 'cli': return 100;
    case 'script': return 90;
    case 'task': return 80;
    default: return 50;
  }
}

function findBestPath(startId, adjacency, nodeById, maxDepth) {
  const best = { score: -1, ids: [startId] };

  function visit(currentId, depth, seen, pathIds) {
    const neighbors = adjacency.get(currentId) || [];
    const currentScore = scorePath(pathIds, nodeById);
    if (currentScore > best.score) {
      best.score = currentScore;
      best.ids = [...pathIds];
    }
    if (depth >= maxDepth) {
      return;
    }
    for (const neighborId of neighbors) {
      if (seen.has(neighborId)) {
        continue;
      }
      seen.add(neighborId);
      pathIds.push(neighborId);
      visit(neighborId, depth + 1, seen, pathIds);
      pathIds.pop();
      seen.delete(neighborId);
    }
  }

  visit(startId, 0, new Set([startId]), [startId]);
  return best.ids;
}

function scorePath(pathIds, nodeById) {
  return pathIds.reduce((score, nodeId, index) => {
    const node = nodeById.get(nodeId);
    if (!node) {
      return score;
    }
    let value = 2;
    if (node.kind === 'file') value += 1;
    if (node.kind === 'class') value += 2;
    if (node.kind === 'function' || node.kind === 'method') value += 3;
    if (node.isHotspot) value += 4;
    return score + value - (index * 0.2);
  }, 0);
}

function summarizePath(pathNodes) {
  if (!pathNodes.length) {
    return 'No path found.';
  }
  if (pathNodes.length === 1) {
    return `${pathNodes[0].label} is an isolated entry point.`;
  }
  const labels = pathNodes.slice(0, 4).map((node) => node.label);
  const chain = labels.join(' → ');
  const suffix = pathNodes.length > 4 ? ` → +${pathNodes.length - 4} more` : '';
  return `${chain}${suffix}`;
}

function serializeAdjacency(map) {
  const out = {};
  for (const [key, value] of map.entries()) {
    out[key] = value;
  }
  return out;
}

function findCallExpressions(line) {
  const results = [];
  const callRegex = /([A-Za-z_][\w\.]*)\s*\(/g;
  let match;
  while ((match = callRegex.exec(line)) !== null) {
    const expr = match[1];
    if (!expr || KEYWORDS.has(expr)) {
      continue;
    }
    results.push(expr);
  }
  return results;
}

function extractModuleDocstring(text) {
  const match = text.match(/^\s*(?:[rRuUbBfF]{0,2})?(["']{3})([\s\S]*?)\1/);
  return match ? normalizeDocstring(match[2]) : '';
}

function extractBlockDocstring(lines, definitionIndex, parentIndent) {
  for (let index = definitionIndex + 1; index < Math.min(lines.length, definitionIndex + 12); index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const indent = getIndent(line);
    if (indent <= parentIndent) {
      return '';
    }
    const tripleMatch = trimmed.match(/^(?:[rRuUbBfF]{0,2})?(["']{3})([\s\S]*)$/);
    if (!tripleMatch) {
      return '';
    }
    const quote = tripleMatch[1];
    let content = trimmed.slice(trimmed.indexOf(quote) + quote.length);
    if (content.includes(quote)) {
      return normalizeDocstring(content.slice(0, content.indexOf(quote)));
    }
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const part = lines[inner];
      if (part.includes(quote)) {
        content += `\n${part.slice(0, part.indexOf(quote))}`;
        return normalizeDocstring(content);
      }
      content += `\n${part}`;
    }
    return normalizeDocstring(content);
  }
  return '';
}

function normalizeDocstring(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
}

function createNode(data) {
  return {
    id: data.id,
    label: data.label,
    kind: data.kind,
    filePath: data.filePath,
    relativePath: data.relativePath,
    line: data.line,
    signature: data.signature || '',
    parentId: data.parentId || null,
    parentClassId: data.parentClassId || null,
    qualifiedName: data.qualifiedName || data.label,
    decorators: data.decorators || [],
    docstring: data.docstring || '',
    isEntryPoint: Boolean(data.isEntryPoint),
    entryCategory: data.entryCategory || null,
    entryLabel: data.entryLabel || null,
    entryReason: data.entryReason || null,
    entryRoute: data.entryRoute || null,
    isHotspot: Boolean(data.isHotspot)
  };
}

function createContainsEdge(source, target) {
  return {
    id: `contains:${source}:${target}`,
    source,
    target,
    kind: 'contains'
  };
}

function pushToMapArray(map, key, value) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(value);
}

function setNestedMapValue(parentMap, keyA, keyB, value) {
  if (!parentMap.has(keyA)) {
    parentMap.set(keyA, new Map());
  }
  parentMap.get(keyA).set(keyB, value);
}

function getNestedMapValue(parentMap, keyA, keyB) {
  if (!parentMap.has(keyA)) {
    return null;
  }
  return parentMap.get(keyA).get(keyB) || null;
}

function splitImportSpec(spec) {
  return spec
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function getIndent(line) {
  const whitespace = line.match(/^\s*/)[0];
  return whitespace.replace(/\t/g, '    ').length;
}

function toModuleName(relativePath) {
  const withoutExtension = relativePath.replace(/\.py$/, '');
  const dotted = withoutExtension.replace(/\//g, '.');
  return dotted.replace(/\.__init__$/, '');
}

function resolveImportSource(importSource, currentModuleName, isPackage) {
  if (!importSource.startsWith('.')) {
    return importSource;
  }

  const dotCount = (importSource.match(/^\.+/) || [''])[0].length;
  const remainder = importSource.slice(dotCount);
  const moduleParts = currentModuleName ? currentModuleName.split('.') : [];
  const packageParts = isPackage ? moduleParts : moduleParts.slice(0, -1);
  const baseLength = Math.max(packageParts.length - (dotCount - 1), 0);
  const baseParts = packageParts.slice(0, baseLength);
  const remainderParts = remainder ? remainder.split('.') : [];
  return [...baseParts, ...remainderParts].filter(Boolean).join('.');
}

function dedupeEdges(edges) {
  const seen = new Set();
  for (let index = edges.length - 1; index >= 0; index -= 1) {
    const edge = edges[index];
    const key = `${edge.kind}:${edge.source}:${edge.target}:${edge.label || ''}`;
    if (seen.has(key)) {
      edges.splice(index, 1);
      continue;
    }
    seen.add(key);
  }
}

module.exports = {
  analyzeWorkspace
};
