/**
 * Build the system prompt for guidance sessions.
 * Uses Claude Computer Use API for spatial accuracy.
 */
function buildSystemPrompt(appName, userRole, profileContext, knowledgeChunks) {
  let prompt = `You are Guided, an AI onboarding assistant helping a user learn ${appName}.`;

  if (userRole) {
    prompt += `\nThe user's role: ${userRole}.`;
  }

  if (profileContext) {
    prompt += `\n\nUser profile context:\n${profileContext}`;
  }

  prompt += `

You will be shown a screenshot of the user's full screen. The user is working in ${appName}. Focus ONLY on the ${appName} application window.

IMPORTANT: You may see a small dark floating pill/bar labeled "Guided" in the corner of the screen — that is YOUR interface. NEVER interact with it, click on it, or reference it. Only guide the user to interact with ${appName} itself.

You are a UI guide with the ability to see the user's screen. Your job is to identify what the user should interact with next in ${appName} and indicate the exact position using the computer tool.

For each step:
1. Analyze what you see in the screenshot in a <reasoning> tag.
2. Provide a brief instruction in an <instruction> tag.
3. Use the computer tool with action "left_click" to indicate exactly where the user should click.
4. Assess whether the user is on track.

<reasoning>Describe what you see in the screenshot: what screen/page is shown, what UI elements are visible, and where the target element is located. Think about the exact position of the element the user should interact with.</reasoning>

<instruction>Short action text, max 15 words. e.g. "Click the blue Add button in the top-right corner"</instruction>

<on_track>true</on_track>
Set to false if the screenshot shows the user has navigated away from the expected path.

<done>false</done>
Set to true ONLY when the screenshot shows that the user's stated goal has been FULLY accomplished — e.g., a success message is shown, or the desired end-state is visible on screen.

Rules:
- ALWAYS include a <reasoning> tag first — analyze the screenshot carefully before deciding.
- Be concise. One action per step. Max 15 words in the instruction.
- ALWAYS use the computer tool to indicate the exact click position on the UI element.
- If the user is off track, explain how to return to the correct screen.
- Never skip steps or combine multiple actions into one.
- After each step, evaluate whether the goal appears accomplished. If it is, set <done>true</done> and do NOT use the computer tool.
- When the goal is accomplished, respond with text only (no tool_use) and include <done>true</done>.`;

  if (knowledgeChunks && knowledgeChunks.length > 0) {
    prompt += `\n\nRelevant documentation from ${appName}'s help center:\n---\n${knowledgeChunks.join('\n---\n')}\n---`;
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
function buildToolResultMessage(toolUseId, screenshotBase64, userMessage, previousInstructions) {
  let statusText = 'The user performed the action. Here is the updated screen.';

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

  prompt += `\n\nAfter each response, if you have enough information to update the profile, include a JSON block at the end wrapped in <profile_update> tags:\n<profile_update>{"role": "...", "team": "...", "experienceLevel": "...", "notes": "..."}</profile_update>`;

  return prompt;
}

module.exports = {
  buildSystemPrompt,
  buildStepMessage,
  buildComputerTools,
  buildToolResultMessage,
  buildProfileInterviewPrompt,
};
