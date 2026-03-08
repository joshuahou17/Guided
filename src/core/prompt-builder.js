/**
 * Build the system prompt for guidance sessions.
 * Uses Claude Computer Use API for spatial accuracy.
 */
function buildSystemPrompt(appName, userRole, profileContext, graphContext, researchContext, appGuide, workflowPlan = null) {
  let prompt = `You are Guided, an AI onboarding assistant helping a user learn ${appName}.`;

  if (userRole) {
    prompt += `\nThe user's role: ${userRole}.`;
  }

  if (profileContext) {
    prompt += `\n\nUser profile context:\n${profileContext}`;
  }

  if (appGuide) {
    prompt += `\n\n=== App Guide for ${appName} ===\nThe following describes ${appName}'s layout, navigation, and workflows. Use this as your primary reference for understanding where UI elements are located and how to navigate the app:\n${appGuide}\n=== End App Guide ===`;
  }

  prompt += `

You will be shown a screenshot of the user's full screen. The user is working in ${appName}. Focus ONLY on the ${appName} application window.

IMPORTANT: You may see a small dark floating pill/bar labeled "Guided" in the corner of the screen — that is YOUR interface. NEVER interact with it, click on it, or reference it. Only guide the user to interact with ${appName} itself.

You are a UI guide with the ability to see the user's screen. Your job is to identify what the user should interact with next in ${appName} and indicate the exact position using the computer tool.

For each step:
1. Analyze what you see in the screenshot in a <reasoning> tag.
2. Provide a brief instruction in an <instruction> tag.
3. Use the computer tool with action "left_click" to indicate exactly where the user should interact.
4. Set the action type.
5. Assess whether the user is on track.

<reasoning>Describe what you see in the screenshot: what screen/page is shown, what UI elements are visible, and where the target element is located. Think about the exact position of the element the user should interact with.</reasoning>

<instruction>Short action text, max 15 words. e.g. "Click the blue Add button in the top-right corner"</instruction>

<action_type>click</action_type>
Set to "click" when the user needs to click a UI element.
Set to "text_input" when the user needs to type text into a field. Use the computer tool to indicate the text field location.

<on_track>true</on_track>
Set to false if the screenshot shows the user has navigated away from the expected path.

<done>false</done>
Set to true ONLY when the screenshot shows that the user's stated goal has been FULLY accomplished — e.g., a success message is shown, or the desired end-state is visible on screen.

Rules:
- ALWAYS include a <reasoning> tag first — analyze the screenshot carefully before deciding.
- Be concise. One action per step. Max 15 words in the instruction.
- ALWAYS use the computer tool to indicate the exact position on the UI element.
- If the user is off track, explain how to return to the correct screen.
- Never skip steps or combine multiple actions into one.
- When the user needs to type text (fill a form field, write a description, enter a name), set <action_type>text_input</action_type> and tell the user exactly what to type. Do NOT set done until you can see the typed text on screen.
- If the screenshot appears unchanged from the previous step, your previous instruction may have been wrong or the user's action didn't work. Re-evaluate the screen and try a different approach — do NOT repeat the same instruction.
- After each step, evaluate whether the goal appears accomplished. If it is, set <done>true</done> and do NOT use the computer tool.
- When the goal is accomplished, respond with text only (no tool_use) and include <done>true</done>.
- If a Workflow Plan is provided, follow it step by step. Reference the plan in your <reasoning> to determine the next action. If the screen doesn't match the expected state for the current plan step, adapt — explain in your reasoning why you're deviating.
- When following a clear plan step, keep your <reasoning> brief — confirm you're on the plan step and identify the target UI element. Save detailed reasoning for when you need to adapt.`;

  // Inject workflow plan (highest priority context after instructions)
  if (workflowPlan && workflowPlan.length > 0) {
    prompt += `\n\n=== Workflow Plan ===\nPlanned steps to achieve the goal:\n`;
    workflowPlan.forEach((step, i) => {
      prompt += `${i + 1}. ${step}\n`;
    });
    prompt += `\nFollow this plan step by step. If the screen shows something different than expected, adapt — the plan is a guide, not a rigid script. When adapting, still aim for the shortest path to the goal.\n=== End Workflow Plan ===`;
  }

  // Inject knowledge graph context (structured, relevant nodes)
  if (graphContext) {
    prompt += `\n\n${graphContext}`;
  }

  // Inject research context (from screenshot-first research pipeline)
  if (researchContext) {
    prompt += researchContext;
  }

  return prompt;
}

/**
 * Build the computer use tools array with image dimensions.
 */
function buildComputerTools(imageWidth, imageHeight) {
  return [
    {
      type: 'computer_20250124',
      name: 'computer',
      display_width_px: imageWidth,
      display_height_px: imageHeight,
    },
  ];
}

/**
 * Build the initial user message for the first step.
 * Includes a screenshot as a base64 image content block + goal text.
 */
function buildStepMessage(screenshotBase64, userGoal, previousInstructions, userMessage) {
  const content = [];

  // Image content block
  content.push({
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      data: screenshotBase64,
    },
  });

  // Text context
  let text = `Goal: ${userGoal}`;

  if (previousInstructions.length > 0) {
    text += '\n\nCompleted steps:';
    previousInstructions.forEach((inst, i) => {
      text += `\n${i + 1}. ${inst}`;
    });
  }

  if (userMessage) {
    text += `\n\nUser says: ${userMessage}`;
  }

  text += '\n\nWhat should the user do next? Use the computer tool to indicate where to click.';

  content.push({ type: 'text', text });

  return { role: 'user', content };
}

/**
 * Build a tool_result message for subsequent steps.
 * Sends the new screenshot as a tool_result keyed to the previous tool_use ID.
 */
function buildToolResultMessage(toolUseId, screenshotBase64, userMessage, previousInstructions, actionType = 'click') {
  const statusMessages = {
    text_input: 'The user has finished typing and confirmed by clicking Done. This step is COMPLETE — do NOT repeat the typing instruction. Move on to the next step in the workflow. Here is the updated screen.',
    click: 'The user clicked where indicated. Here is the updated screen. If the screen looks the same as before, the click may not have had the expected effect — try a different approach.',
  };
  let statusText = statusMessages[actionType] || statusMessages.click;

  if (previousInstructions && previousInstructions.length > 0) {
    statusText += '\n\nCompleted steps so far:';
    previousInstructions.forEach((inst, i) => {
      statusText += `\n${i + 1}. ${inst}`;
    });
  }

  if (userMessage) {
    statusText += `\n\nUser says: ${userMessage}`;
  }

  statusText += '\n\nWhat should the user do next?';

  const content = [
    {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: screenshotBase64,
          },
        },
        {
          type: 'text',
          text: statusText,
        },
      ],
    },
  ];

  return { role: 'user', content };
}

/**
 * Build system prompt for profile AI interview.
 */
function buildProfileInterviewPrompt(appName, currentProfile) {
  let prompt = `You are a friendly assistant helping a user build their profile for using ${appName}. Ask targeted questions to understand their role, experience level, goals, and pain points with ${appName}.`;

  if (currentProfile) {
    prompt += `\n\nCurrent profile data:\n${JSON.stringify(currentProfile, null, 2)}`;
    prompt += `\n\nBased on this existing profile, ask follow-up questions to fill in gaps or update outdated information. Keep it conversational and brief.`;
  } else {
    prompt += `\n\nNo profile exists yet. Start by asking about their role and what they primarily use ${appName} for.`;
  }

  prompt += `\n\nAfter each response, if you have enough information to update the profile, include a JSON block at the end wrapped in <profile_update> tags:\n<profile_update>{"role": "...", "team": "...", "experienceLevel": "...", "notes": "...", "appGuide": "..."}</profile_update>`;
  prompt += `\n\nThe "appGuide" field should describe the app's UI layout, navigation structure, and common workflows if the user provides such information. For example: "Left sidebar has: Dashboard, Projects, Tasks. Top bar has search and + New button. To create a project: click + New > Project."`;

  return prompt;
}

/**
 * Build system prompt for the first step when research hasn't completed yet.
 * Same as buildSystemPrompt but without research context, and with a note
 * that research is loading.
 */
function buildSystemPromptWithoutResearch(appName, userRole, profileContext, graphContext, appGuide, workflowPlan = null) {
  let prompt = buildSystemPrompt(appName, userRole, profileContext, graphContext, '', appGuide, workflowPlan);
  prompt += '\n\nNote: Background research on this application is in progress and will be available for subsequent steps. For now, guide the user based on what you can see on screen.';
  return prompt;
}

/**
 * Build the prompt for the workflow planning call.
 */
function buildPlanningPrompt(appName, goal, currentView, appGuide, similarWorkflows) {
  const systemPrompt = `You are a workflow planner for software applications. Given a user's goal and context about the app, plan the most efficient step-by-step workflow. Each step should be one concrete action (click a button, type text, select a menu item). Be specific about what UI element to interact with and where it is. Aim for the shortest path to the goal.

Return ONLY a JSON array of step strings. No other text.

Example: ["Click the + button next to Your Library", "Select Playlist from the dropdown menu", "Type the playlist name", "Click Save"]`;

  let userMsg = `Plan the optimal workflow for this goal in ${appName}.\n\nGoal: ${goal}`;

  if (currentView && currentView !== 'Unknown' && currentView !== 'Unknown view') {
    userMsg += `\nCurrent view: ${currentView}`;
  }

  if (appGuide) {
    userMsg += `\n\nApp layout and navigation:\n${appGuide}`;
  }

  if (similarWorkflows && similarWorkflows.length > 0) {
    userMsg += '\n\nSimilar workflows that have worked before:';
    for (const wf of similarWorkflows) {
      userMsg += `\n- "${wf.name}": ${wf.steps.join(' → ')}`;
      if (wf.completionCount > 0) userMsg += ` (used successfully ${wf.completionCount} time${wf.completionCount > 1 ? 's' : ''})`;
    }
  }

  return { systemPrompt, userMsg };
}

module.exports = {
  buildSystemPrompt,
  buildSystemPromptWithoutResearch,
  buildStepMessage,
  buildComputerTools,
  buildToolResultMessage,
  buildProfileInterviewPrompt,
  buildPlanningPrompt,
};
