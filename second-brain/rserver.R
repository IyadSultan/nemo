# One R session for the R tab. Node (rsession.js) writes one JSON line per request on stdin:
#   {"id":"…","code":"…"}
# and reads one JSON line per answer on stdout:
#   {"id":"…","items":[{"type":"text|table|plot|message|warning|error","text":"…"|"html":"…"|"file":"…"}]}
# Everything runs in the global environment, so variables carry over between runs, as in a
# console. Plots are saved as PNG files under <out_root>/<id>/; data frames come back as HTML.
# Usage: Rscript rserver.R <out_root>
suppressPackageStartupMessages({ library(evaluate); library(jsonlite) })
# The packages most code starts with, so neither the user nor the brain has to library() them.
for (pkg in c("dplyr", "tidyr", "ggplot2", "readr")) {
  suppressPackageStartupMessages(try(library(pkg, character.only = TRUE), silent = TRUE))
}
out_root <- commandArgs(trailingOnly = TRUE)[1]
dir.create(out_root, recursive = TRUE, showWarnings = FALSE)
options(width = 100, warn = 1)
MAX_ROWS <- 200

# Data frames and matrices go back as a table, in order with the text around them.
TABLE <- "\001TABLE\001"
TABLE_END <- "\001/TABLE\001"
show_value <- function(x, visible) {
  if (!visible) return(invisible(NULL))
  if (is.data.frame(x) || is.matrix(x)) {
    df <- as.data.frame(x)
    n <- nrow(df)
    named <- !identical(rownames(df), as.character(seq_len(n)))
    html <- knitr::kable(utils::head(df, MAX_ROWS), format = "html", escape = TRUE, row.names = named)
    more <- if (n > MAX_ROWS) sprintf('<p class="rt-more">%s rows; the first %s are shown.</p>', format(n, big.mark = ","), MAX_ROWS) else ""
    cat(TABLE, as.character(html), more, TABLE_END, sep = "")
  } else {
    print(x)
  }
  invisible(NULL)
}
handler <- new_output_handler(value = show_value)

# A text item, split around any tables it carries.
text_items <- function(s) {
  items <- list()
  while (nchar(s) > 0) {
    at <- regexpr(TABLE, s, fixed = TRUE)
    if (at < 0) { items[[length(items) + 1]] <- list(type = "text", text = s); break }
    if (at > 1) items[[length(items) + 1]] <- list(type = "text", text = substr(s, 1, at - 1))
    rest <- substr(s, at + nchar(TABLE), nchar(s))
    end <- regexpr(TABLE_END, rest, fixed = TRUE)
    if (end < 0) { items[[length(items) + 1]] <- list(type = "table", html = rest); break }
    items[[length(items) + 1]] <- list(type = "table", html = substr(rest, 1, end - 1))
    s <- substr(rest, end + nchar(TABLE_END), nchar(rest))
  }
  items
}

run_one <- function(id, code) {
  dir <- file.path(out_root, id)
  dir.create(dir, recursive = TRUE, showWarnings = FALSE)
  items <- list()
  nplot <- 0
  add <- function(item) items[[length(items) + 1]] <<- item
  res <- evaluate(code, envir = globalenv(), output_handler = handler, stop_on_error = 1L, new_device = TRUE)
  for (x in res) {
    if (inherits(x, "source")) next
    if (is.character(x)) {
      for (item in text_items(paste(x, collapse = ""))) add(item)
    } else if (inherits(x, "recordedplot")) {
      nplot <- nplot + 1
      file <- sprintf("plot-%d.png", nplot)
      ok <- tryCatch({
        png(file.path(dir, file), width = 1600, height = 1000, res = 180)
        on.exit(dev.off(), add = TRUE)
        replayPlot(x)
        dev.off()
        on.exit()
        TRUE
      }, error = function(e) { add(list(type = "error", text = paste("The plot could not be drawn:", conditionMessage(e)))); FALSE })
      if (ok) add(list(type = "plot", file = file))
    } else if (inherits(x, "error")) {
      add(list(type = "error", text = paste("Error:", conditionMessage(x))))
    } else if (inherits(x, "warning")) {
      add(list(type = "warning", text = paste("Warning:", conditionMessage(x))))
    } else if (inherits(x, "message")) {
      add(list(type = "message", text = sub("\n$", "", conditionMessage(x))))
    }
  }
  items
}

con <- file("stdin", open = "r", blocking = TRUE)
repeat {
  line <- readLines(con, n = 1, warn = FALSE)
  if (length(line) == 0) break
  req <- tryCatch(fromJSON(line, simplifyVector = TRUE), error = function(e) NULL)
  if (is.null(req) || is.null(req$id)) next
  items <- tryCatch(run_one(req$id, req$code), error = function(e) list(list(type = "error", text = paste("Error:", conditionMessage(e)))))
  cat(toJSON(list(id = req$id, items = items), auto_unbox = TRUE, null = "null"), "\n", sep = "")
  flush(stdout())
}
