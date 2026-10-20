/** The file a child writes its question to, inside its job directory. */
export const QUESTION_FILE = 'question.txt'

/** The paragraph every child prompt ends with. The child writes its question to the job directory and stops. */
export const QUESTION_PROTOCOL =
  'If you are blocked on a question that the brief does not answer, write the question to $ORQ_JOB_DIR/question.txt, print BLOCKED: followed by the question as your final message, and stop.'
