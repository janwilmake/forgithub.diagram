/**
 * This implementation implements an API based off https://github.com/ahmedkhaleel2004/gitdiagram/tree/main with a few notable changes
 *
 * - uses cloudflare workers with KV and a queue instead of a container-based server
 * - went from 14000 tokens of backend to ±5000 tokens (and fewer files)
 * - /owner/repo/image.html renders it as HTML
 * - added similar frontend for browsers
 *
 *
 * Possible improvements:
 * - use cloudflare browser rendering to expose /owner/repo/image.svg as well as /owner/repo/image.png (do something similar to https://github.com/alfonsusac/mermaid-ssr)
 * - use https://uithub.com/openapi.html to retrieve the tree instead of the github api (to bypass the ratelimit)
 * - add monetisation using https://sponsorflare.com
 */
export interface Env {
  // KV Namespace for storing diagrams
  DIAGRAMS_KV: KVNamespace;

  // Queue for processing diagram generation
  DIAGRAM_QUEUE: Queue<QueueMessage>;

  // Environment variables
  GITHUB_TOKEN: string;
  OPENAI_API_KEY: string;
}

export interface QueueMessage {
  owner: string;
  repo: string;
  cacheKey: string;
}

// KV stored data structure
export interface DiagramData {
  status: "pending" | "complete" | "error";
  diagram?: string;
  error?: string;
  created?: string;
  generated?: string;
  failed?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only allow GET requests
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    const [_, owner, repo, page] = path.split("/");
    if (!owner || !repo) {
      return new Response("Invalid path. Use format: /owner/repo", {
        status: 400,
      });
    }

    const cacheKey = `diagram:${owner}:${repo}`;

    try {
      // Check if result exists in KV
      const cachedResult = await env.DIAGRAMS_KV.get<DiagramData>(cacheKey, {
        type: "json",
      });

      if (cachedResult) {
        // If status is pending, return 202 Accepted
        if (cachedResult.status === "pending") {
          return new Response(
            JSON.stringify({
              status: "pending",
              message: "Diagram generation in progress",
            }),
            {
              status: 202,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (page === "image.html" && cachedResult.diagram) {
          return new Response(
            `<!doctype html>
<html lang="en">
  <body>
    <pre class="mermaid">
${cachedResult.diagram}
    </pre>
    <script type="module">
      import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
    </script>
  </body>
</html>`,
            { headers: { "content-type": "text/html" } },
          );
        }
        // If diagram exists, return it with 200 OK
        return new Response(cachedResult.diagram, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }

      // If not in KV, set pending status and add to queue
      await env.DIAGRAMS_KV.put(
        cacheKey,
        JSON.stringify({
          status: "pending",
          created: new Date().toISOString(),
        }),
      );

      // Add job to queue
      await env.DIAGRAM_QUEUE.send({
        owner,
        repo,
        cacheKey,
      });

      // Return 202 Accepted
      return new Response(
        JSON.stringify({
          status: "pending",
          message: "Diagram generation started",
        }),
        {
          status: 202,
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error: any) {
      console.error("Error processing request:", error);
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          message: error.message,
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const { owner, repo, cacheKey } = message.body;
        console.log(`Processing diagram for ${owner}/${repo}`);

        // Generate the diagram using the three-step process
        const diagram = await generateDiagram(owner, repo, env);

        // Store the result in KV
        await env.DIAGRAMS_KV.put(
          cacheKey,
          JSON.stringify({
            status: "complete",
            diagram,
            generated: new Date().toISOString(),
          }),
          {
            // Cache for 7 days
            expirationTtl: 60 * 60 * 24 * 7,
          },
        );

        console.log(`Completed diagram for ${owner}/${repo}`);
      } catch (error: any) {
        console.error(`Error processing message: ${error.message}`);

        // Store the error in KV
        if (message.body.cacheKey) {
          await env.DIAGRAMS_KV.put(
            message.body.cacheKey,
            JSON.stringify({
              status: "error",
              error: error.message,
              failed: new Date().toISOString(),
            } satisfies DiagramData),
            {
              // Cache errors for 1 day
              expirationTtl: 60 * 60 * 24,
            },
          );
        }
      }
    }
  },
};

async function generateDiagram(
  owner: string,
  repo: string,
  env: Env,
): Promise<string> {
  // 1. Fetch repository data
  const [fileTree, readme, defaultBranch] = await fetchRepositoryData(
    owner,
    repo,
    env,
  );

  // 2. First prompt: Generate explanation
  const explanation = await generateExplanation(fileTree, readme, env);

  // 3. Second prompt: Create component mapping
  const componentMapping = await createComponentMapping(
    explanation,
    fileTree,
    env,
  );

  // 4. Third prompt: Generate Mermaid diagram
  const mermaidCode = await generateMermaidDiagram(
    explanation,
    componentMapping,
    env,
  );

  // 5. Post-process the diagram (add GitHub URLs to click events)
  return processClickEvents(mermaidCode, owner, repo, defaultBranch);
}

async function fetchRepositoryData(
  owner: string,
  repo: string,
  env: Env,
): Promise<[string, string, string]> {
  // Get default branch
  const repoInfoResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}`,
    {
      headers: {
        "User-Agent": "GitDiagram-Cloudflare-Worker",
        ...(env.GITHUB_TOKEN && { Authorization: `token ${env.GITHUB_TOKEN}` }),
      },
    },
  );

  if (!repoInfoResponse.ok) {
    throw new Error(
      `Failed to fetch repository info: ${repoInfoResponse.status}`,
    );
  }

  const repoInfo: { default_branch: string | null } =
    await repoInfoResponse.json();
  const defaultBranch = repoInfo.default_branch || "main";

  // Get file tree
  const treeResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`,
    {
      headers: {
        "User-Agent": "GitDiagram-Cloudflare-Worker",
        ...(env.GITHUB_TOKEN && { Authorization: `token ${env.GITHUB_TOKEN}` }),
      },
    },
  );

  if (!treeResponse.ok) {
    throw new Error(`Failed to fetch file tree: ${treeResponse.status}`);
  }

  const treeData: { tree: { path: string }[] } = await treeResponse.json();

  // Filter out unwanted files (similar to the original service)
  const excludedPatterns = [
    "node_modules/",
    "vendor/",
    "venv/",
    ".min.",
    ".pyc",
    ".pyo",
    ".pyd",
    ".so",
    ".dll",
    ".class",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".ico",
    ".svg",
    ".ttf",
    ".woff",
    ".webp",
    "__pycache__/",
    ".cache/",
    ".tmp/",
    "yarn.lock",
    "poetry.lock",
    "*.log",
    ".vscode/",
    ".idea/",
  ];

  const shouldIncludeFile = (path: string): boolean => {
    return !excludedPatterns.some((pattern) =>
      path.toLowerCase().includes(pattern),
    );
  };

  const fileTree = treeData.tree
    .filter((item) => shouldIncludeFile(item.path))
    .map((item) => item.path)
    .join("\n");

  // Get README
  const readmeResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/readme`,
    {
      headers: {
        "User-Agent": "GitDiagram-Cloudflare-Worker",
        ...(env.GITHUB_TOKEN && { Authorization: `token ${env.GITHUB_TOKEN}` }),
      },
    },
  );

  if (!readmeResponse.ok) {
    throw new Error(`Failed to fetch README: ${readmeResponse.status}`);
  }

  const readmeData: { download_url: string } = await readmeResponse.json();
  const readmeContentResponse = await fetch(readmeData.download_url);
  const readme = await readmeContentResponse.text();

  return [fileTree, readme, defaultBranch];
}

async function generateExplanation(
  fileTree: string,
  readme: string,
  env: Env,
): Promise<string> {
  const SYSTEM_FIRST_PROMPT = `
    You are tasked with explaining to a principal software engineer how to draw the best and most accurate system design diagram / architecture of a given project. This explanation should be tailored to the specific project's purpose and structure. To accomplish this, you will be provided with two key pieces of information:

    1. The complete and entire file tree of the project including all directory and file names, which will be enclosed in <file_tree> tags in the users message.

    2. The README file of the project, which will be enclosed in <readme> tags in the users message.

    Analyze these components carefully, as they will provide crucial information about the project's structure and purpose. Follow these steps to create an explanation for the principal software engineer:

    1. Identify the project type and purpose:
       - Examine the file structure and README to determine if the project is a full-stack application, an open-source tool, a compiler, or another type of software imaginable.
       - Look for key indicators in the README, such as project description, features, or use cases.

    2. Analyze the file structure:
       - Pay attention to top-level directories and their names (e.g., "frontend", "backend", "src", "lib", "tests").
       - Identify patterns in the directory structure that might indicate architectural choices (e.g., MVC pattern, microservices).
       - Note any configuration files, build scripts, or deployment-related files.

    3. Examine the README for additional insights:
       - Look for sections describing the architecture, dependencies, or technical stack.
       - Check for any diagrams or explanations of the system's components.

    4. Based on your analysis, explain how to create a system design diagram that accurately represents the project's architecture. Include the following points:

       a. Identify the main components of the system (e.g., frontend, backend, database, building, external services).
       b. Determine the relationships and interactions between these components.
       c. Highlight any important architectural patterns or design principles used in the project.
       d. Include relevant technologies, frameworks, or libraries that play a significant role in the system's architecture.

    5. Provide guidelines for tailoring the diagram to the specific project type:
       - For a full-stack application, emphasize the separation between frontend and backend, database interactions, and any API layers.
       - For an open-source tool, focus on the core functionality, extensibility points, and how it integrates with other systems.
       - For a compiler or language-related project, highlight the different stages of compilation or interpretation, and any intermediate representations.

    6. Instruct the principal software engineer to include the following elements in the diagram:
       - Clear labels for each component
       - Directional arrows to show data flow or dependencies
       - Color coding or shapes to distinguish between different types of components

    7. NOTE: Emphasize the importance of being very detailed and capturing the essential architectural elements. Don't overthink it too much, simply separating the project into as many components as possible is best.

    Present your explanation and instructions within <explanation> tags, ensuring that you tailor your advice to the specific project based on the provided file tree and README content.
  `;

  const response = await callAI(
    SYSTEM_FIRST_PROMPT,
    { file_tree: fileTree, readme },
    env,
  );

  // Extract explanation from response
  const explanationMatch = response.match(
    /<explanation>([\s\S]*)<\/explanation>/,
  );
  return explanationMatch ? explanationMatch[1].trim() : response;
}

async function createComponentMapping(
  explanation: string,
  fileTree: string,
  env: Env,
): Promise<string> {
  const SYSTEM_SECOND_PROMPT = `
    You are tasked with mapping key components of a system design to their corresponding files and directories in a project's file structure. You will be provided with a detailed explanation of the system design/architecture and a file tree of the project.

    First, carefully read the system design explanation which will be enclosed in <explanation> tags in the users message.

    Then, examine the file tree of the project which will be enclosed in <file_tree> tags in the users message.

    Your task is to analyze the system design explanation and identify key components, modules, or services mentioned. Then, try your best to map these components to what you believe could be their corresponding directories and files in the provided file tree.

    Guidelines:
    1. Focus on major components described in the system design.
    2. Look for directories and files that clearly correspond to these components.
    3. Include both directories and specific files when relevant.
    4. If a component doesn't have a clear corresponding file or directory, simply dont include it in the map.

    Now, provide your final answer in the following format:

    <component_mapping>
    1. [Component Name]: [File/Directory Path]
    2. [Component Name]: [File/Directory Path]
    [Continue for all identified components]
    </component_mapping>

    Remember to be as specific as possible in your mappings, only use what is given to you from the file tree, and to strictly follow the components mentioned in the explanation.
  `;

  const response = await callAI(
    SYSTEM_SECOND_PROMPT,
    { explanation, file_tree: fileTree },
    env,
  );

  // Extract component mapping from response
  const mappingMatch = response.match(
    /<component_mapping>([\s\S]*)<\/component_mapping>/,
  );
  return mappingMatch ? mappingMatch[1].trim() : response;
}

async function generateMermaidDiagram(
  explanation: string,
  componentMapping: string,
  env: Env,
): Promise<string> {
  const SYSTEM_THIRD_PROMPT = `
    You are a principal software engineer tasked with creating a system design diagram using Mermaid.js based on a detailed explanation. Your goal is to accurately represent the architecture and design of the project as described in the explanation.

    The detailed explanation of the design will be enclosed in <explanation> tags in the users message.

    Also, sourced from the explanation, as a bonus, a few of the identified components have been mapped to their paths in the project file tree, whether it is a directory or file which will be enclosed in <component_mapping> tags in the users message.

    To create the Mermaid.js diagram:

    1. Carefully read and analyze the provided design explanation.
    2. Identify the main components, services, and their relationships within the system.
    3. Determine the appropriate Mermaid.js diagram type to use (e.g., flowchart, sequence diagram, class diagram, architecture, etc.) based on the nature of the system described.
    4. Create the Mermaid.js code to represent the design, ensuring that:
       a. All major components are included
       b. Relationships between components are clearly shown
       c. The diagram accurately reflects the architecture described in the explanation
       d. The layout is logical and easy to understand

    Guidelines for diagram components and relationships:
    - Use appropriate shapes for different types of components (e.g., rectangles for services, cylinders for databases, etc.)
    - Use clear and concise labels for each component
    - Show the direction of data flow or dependencies using arrows
    - Group related components together if applicable
    - Include any important notes or annotations mentioned in the explanation
    - Just follow the explanation. It will have everything you need.

    IMPORTANT!!: Please orient and draw the diagram as vertically as possible. You must avoid long horizontal lists of nodes and sections!

    You must include click events for components of the diagram that have been specified in the provided <component_mapping>:
    - Do not try to include the full url. This will be processed by another program afterwards. All you need to do is include the path.
    - For example:
      - This is a correct click event: \`click Example "app/example.js"\`
      - This is an incorrect click event: \`click Example "https://github.com/username/repo/blob/main/app/example.js"\`
    - Do this for as many components as specified in the component mapping, include directories and files.
      - If you believe the component contains files and is a directory, include the directory path.
      - If you believe the component references a specific file, include the file path.
    - Make sure to include the full path to the directory or file exactly as specified in the component mapping.
    - It is very important that you do this for as many files as possible. The more the better.

    - IMPORTANT: THESE PATHS ARE FOR CLICK EVENTS ONLY, these paths should not be included in the diagram's node's names. Only for the click events. Paths should not be seen by the user.

    Your output should be valid Mermaid.js code that can be rendered into a diagram.

    Do not include an init declaration such as \`%%{init: {'key':'etc'}}%%\`. This is handled externally. Just return the diagram code.

    Your response must strictly be just the Mermaid.js code, without any additional text or explanations.
    No code fence or markdown ticks needed, simply return the Mermaid.js code.

    Ensure that your diagram adheres strictly to the given explanation, without adding or omitting any significant components or relationships.

    EXTREMELY Important notes on syntax!!! (PAY ATTENTION TO THIS):
    - Make sure to add colour to the diagram!!! This is extremely critical.
    - In Mermaid.js syntax, we cannot include special characters for nodes without being inside quotes! For example: \`EX[/api/process (Backend)]:::api\` and \`API -->|calls Process()| Backend\` are two examples of syntax errors. They should be \`EX["/api/process (Backend)"]:::api\` and \`API -->|"calls Process()"| Backend\` respectively. Notice the quotes. This is extremely important. Make sure to include quotes for any string that contains special characters.
    - In Mermaid.js syntax, you cannot apply a class style directly within a subgraph declaration. For example: \`subgraph "Frontend Layer":::frontend\` is a syntax error. However, you can apply them to nodes within the subgraph. For example: \`Example["Example Node"]:::frontend\` is valid, and \`class Example1,Example2 frontend\` is valid.
    - In Mermaid.js syntax, there cannot be spaces in the relationship label names. For example: \`A -->| "example relationship" | B\` is a syntax error. It should be \`A -->|"example relationship"| B\` 
    - In Mermaid.js syntax, you cannot give subgraphs an alias like nodes. For example: \`subgraph A "Layer A"\` is a syntax error. It should be \`subgraph "Layer A"\` 
  `;

  const response = await callAI(
    SYSTEM_THIRD_PROMPT,
    { explanation, component_mapping: componentMapping },
    env,
  );

  // Clean up the response (remove any code blocks if present)
  return response.replace(/```mermaid|```/g, "").trim();
}

function processClickEvents(
  diagram: string,
  owner: string,
  repo: string,
  branch: string,
): string {
  // Match click events: click ComponentName "path/to/something"
  const clickPattern = /click ([^\s"]+)\s+"([^"]+)"/g;

  return diagram.replace(clickPattern, (match, componentName, path) => {
    const cleanedPath = path.trim().replace(/^["']|["']$/g, "");

    // Determine if path is likely a file (has extension) or directory
    const isFile = cleanedPath.split("/").pop().includes(".");

    // Construct GitHub URL
    const baseUrl = `https://github.com/${owner}/${repo}`;
    const pathType = isFile ? "blob" : "tree";
    const fullUrl = `${baseUrl}/${pathType}/${branch}/${cleanedPath}`;

    // Return the full click event with the new URL
    return `click ${componentName} "${fullUrl}"`;
  });
}

async function callAI(
  systemPrompt: string,
  data: Record<string, string>,
  env: Env,
): Promise<string> {
  // Format the user message with XML tags
  const userMessage = Object.entries(data)
    .map(([key, value]) => `<${key}>\n${value}\n</${key}>`)
    .join("\n\n");

  // Call OpenAI, Anthropic, or any preferred AI service
  // This example uses OpenAI's API
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4-turbo", // Or another suitable model
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.2,
      max_tokens: 4000,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`AI API error: ${response.status} ${error}`);
  }

  const result: any = await response.json();
  return result.choices[0].message.content;
}
