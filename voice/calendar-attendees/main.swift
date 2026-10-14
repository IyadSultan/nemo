import EventKit
import Foundation

// Usage: calendar-attendees <startEpochMs> <endEpochMs>
// Prints JSON: events overlapping the window, with attendee names.
let args = CommandLine.arguments
let start = Date(timeIntervalSince1970: (Double(args[1]) ?? 0) / 1000)
let end = Date(timeIntervalSince1970: (Double(args[2]) ?? 0) / 1000)
let store = EKEventStore()
let sem = DispatchSemaphore(value: 0)
var granted = false
store.requestFullAccessToEvents { ok, _ in granted = ok; sem.signal() }
sem.wait()
if !granted {
  print("{\"error\":\"no-access\"}")
  exit(0)
}
let pred = store.predicateForEvents(withStart: start, end: end, calendars: nil)
let events = store.events(matching: pred).filter { !$0.isAllDay }.map { ev -> [String: Any] in
  let people = (ev.attendees ?? []).compactMap { $0.name }
  return [
    "title": ev.title ?? "",
    "start": ev.startDate.timeIntervalSince1970 * 1000,
    "end": ev.endDate.timeIntervalSince1970 * 1000,
    "organizer": ev.organizer?.name ?? "",
    "attendees": people,
  ]
}
let data = try! JSONSerialization.data(withJSONObject: ["events": events])
print(String(data: data, encoding: .utf8)!)
