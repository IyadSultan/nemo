/**
 * Phrases the user can say or type, and what each one does.
 * "/brain" and "brain functions" show this list as a table. The model does not write it.
 */

/** True for "/brain" or "brain functions" (with a short "show me" in front). Not for "what can you do?". */
export function wantsCommandTable(question) {
  const q = String(question || "").toLowerCase().replace(/[^\p{L}\p{N}\s/]/gu, " ").replace(/\s+/g, " ").trim();
  if (q === "/brain" || q === "brain functions") return true;
  return /^(?:please |hey )?(?:show|list|give|tell)(?: me)? (?:the |about )?(?:brain functions|\/brain)$/.test(q);
}

// say: the phrase to use. does: one plain sentence. group: a heading row in the table.
export const BRAIN_COMMANDS = [
  { group: "Notes and the web", say: "What is on my to-do list?", does: "Answers from your notes. The to-do list, emails, and calendar are part of that." },
  { group: "Notes and the web", say: "What is the latest news today?", does: "Looks up something that changes, such as news, weather, or a price." },

  { group: "PDF", say: "Make a one page summary as a PDF", does: "Writes a new PDF and shows it, with Save and Open." },
  { group: "PDF", say: "Merge the last two PDFs", does: "Joins PDFs you uploaded, ones the brain made, or PDFs on the Desktop, in Downloads, or in Documents." },
  { group: "PDF", say: "Split the PDF", does: "Cuts one PDF into parts. You can say the page ranges, or every page." },
  { group: "PDF", say: "Delete page 3 of the PDF", does: "Removes the pages you name." },
  { group: "PDF", say: "Keep only pages 2 to 4 of the PDF", does: "Makes a new PDF with just those pages." },
  { group: "PDF", say: "Rotate the PDF", does: "Turns pages. Say 90 degrees, or leave it and the app turns them right." },
  { group: "PDF", say: "Reverse the PDF pages", does: "Puts the last page first." },
  { group: "PDF", say: "Add page numbers to the PDF", does: "Prints page 1 of N at the bottom." },
  { group: "PDF", say: "Watermark the PDF with draft", does: "Writes faint text across every page. Draft is used if you do not name the words." },
  { group: "PDF", say: "Make the PDF smaller", does: "Compresses the file." },
  { group: "PDF", say: "Make the scanned PDF searchable", does: "Reads a scan so you can search the words. English only." },

  { group: "Slides", say: "Make a presentation about the budget", does: "Builds a slide deck and a PowerPoint file." },
  { group: "Slides", say: "Start a live presentation about the budget", does: "Opens full screen. What you say next becomes slides. You do not need to say Hey." },
  { group: "Slides", say: "Present it", does: "Opens the last deck full screen." },
  { group: "Slides", say: "Edit the deck with the brain", does: "Opens the editor for the last deck." },
  { group: "Slides", say: "Make the presentation more attractive", does: "Redesigns the last deck. It does not add new facts." },
  { group: "Slides", say: "Add online data to the presentation", does: "Looks up the topic and adds a sources slide." },

  { group: "Word", say: "Open the Word editor", does: "Opens Word beside the brain. Then say Hey and what to change, or what to explain." },

  { group: "Mail, calendar, and memos", say: "Send an email to Haitham about the budget", does: "Opens a draft in Outlook. You press Send. The app never sends mail itself." },
  { group: "Mail, calendar, and memos", say: "Reply to this email", does: "Drafts a reply to the email you were just talking about." },
  { group: "Mail, calendar, and memos", say: "Which emails need a reply?", does: "Names the ones that look urgent." },
  { group: "Mail, calendar, and memos", say: "Find the email from Sara", does: "Lists matches. Then say open number one, two, or three." },
  { group: "Mail, calendar, and memos", say: "What meetings do I have today?", does: "Reads today's calendar. Say tomorrow for the next day." },
  { group: "Mail, calendar, and memos", say: "Open the calendar", does: "Shows the days Outlook has ready, in place of the transcript. Say close the calendar to go back." },
  { group: "Mail, calendar, and memos", say: "Tell me when Eman emails", does: "Texts you when a new saved email from that person shows up. Say stop watching email from Eman to stop." },
  { group: "Mail, calendar, and memos", say: "Text me if I have a meeting before 9", does: "Texts you when a meeting starts before that hour, later today or tomorrow. Say stop watching meetings to stop." },
  { group: "Mail, calendar, and memos", say: "Add an appointment", does: "Opens a form on the calendar. Outlook opens the appointment. It is saved only after you press Add there." },
  { group: "Mail, calendar, and memos", say: "Schedule a meeting tomorrow at 3 pm called budget", does: "Holds an invite until you say send it. Say don't to drop it." },
  { group: "Mail, calendar, and memos", say: "Write a memo that Sara owes the slides", does: "Saves a short note in your notes folder." },
  { group: "Mail, calendar, and memos", say: "What are my recent memos?", does: "Reads memos from the past two weeks. Say all memos for every one." },
  { group: "Mail, calendar, and memos", say: "Open the stickies", does: "Shows the bulletin board. Say close the stickies to go back." },
  { group: "Mail, calendar, and memos", say: "Create a yellow sticky note reminding me to review the proposal tomorrow", does: "Puts a note on the board right away. A short title and hashtags are added after, and a title you lock is kept." },
  { group: "Mail, calendar, and memos", say: "Show all my pink sticky notes", does: "Filters the board by that color. You can also filter by hashtag, priority, or words." },
  { group: "Mail, calendar, and memos", say: "Arrange the notes alphabetically", does: "Lines the notes up by title. Your free positions come back when you choose manual order." },
  { group: "Mail, calendar, and memos", say: "Save a sticky that the lab closes at 4", does: "Puts an ordinary note on the board, with a pin." },
  { group: "Mail, calendar, and memos", say: "Remember: do not be lazy", does: "Keeps that as a memory for later answers, and puts it on the board with the Claude mark instead of a pin. From now on, and save a memory, do the same." },
  { group: "Mail, calendar, and memos", say: "Learn that I want short answers", does: "Keeps a preference for later answers, and puts it on the board with the Claude mark. Say forget that, then the words, to remove it." },
  { group: "Mail, calendar, and memos", say: "What have you learned?", does: "Reads back the preferences you asked it to keep." },

  { group: "Reminders and the work list", say: "Remind me in 20 minutes to call the lab", does: "Sets a reminder. It still fires after a restart. You can also say remind me at 3 pm." },
  { group: "Reminders and the work list", say: "Every weekday at 8 am, text me which emails need a reply", does: "Repeats that question on those days. The answer is read aloud and texted. Say pause, resume, drop, or change the email job to 9 am." },
  { group: "Reminders and the work list", say: "Watch https://example.com", does: "Watches a public page and texts you when it changes." },
  { group: "Reminders and the work list", say: "What jobs", does: "Lists reminders and pages being watched." },
  { group: "Reminders and the work list", say: "Do number two", does: "Starts that idea on the work list. Say skip number two to drop it." },
  { group: "Reminders and the work list", say: "Send it", does: "Opens the draft that is waiting. Say don't to drop it." },

  { group: "Files, sites, and texts", say: "Open the ketamine paper", does: "Finds a file in your notes, then on this Mac, and opens it." },
  { group: "Files, sites, and texts", say: "Find the budget file on my Mac", does: "Searches this Mac like the Finder. Then say open number one." },
  { group: "Files, sites, and texts", say: "Show me cnn.com", does: "Opens that site in the browser." },
  { group: "Files, sites, and texts", say: "Text me the briefing", does: "Sends the words to your phone." },

  { group: "The app", say: "Make it shorter", does: "While an answer is still being written, say stop, make it shorter, instead then what to do, or do the slides first. It continues from the words already written." },
  { group: "The app", say: "Open a terminal", does: "Opens a terminal on this Mac inside the page. Say close the terminal to shut it." },
  { group: "The app", say: "Use the one page summary skill", does: "Follows that skill. Type / and a name to pick one. Say stop the skill to turn it off." },
  { group: "The app", say: "Dance", does: "Tiny does a short move. Wave, drink coffee, and celebrate work the same way." },
  { group: "The app", say: "/brain", does: "Shows this table. Saying brain functions does the same thing." },
];
