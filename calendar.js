'use strict';

require('dotenv').config();
const { google } = require('googleapis');

/**
 * Build an authenticated Google Calendar client using service account credentials.
 * Credentials are stored as a base64-encoded JSON string in GOOGLE_SERVICE_ACCOUNT_KEY.
 */
function getCalendarClient() {
  const encodedKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!encodedKey) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY environment variable is not set');
  }

  let credentials;
  try {
    const decoded = Buffer.from(encodedKey, 'base64').toString('utf-8');
    credentials = JSON.parse(decoded);
  } catch (err) {
    throw new Error(`Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY: ${err.message}`);
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  return google.calendar({ version: 'v3', auth });
}

/**
 * Create a calendar event.
 *
 * @param {Object} params
 * @param {string} params.name                - Attendee name (used in description)
 * @param {string} params.dateTime            - ISO 8601 datetime string, e.g. "2026-03-15T10:00:00Z"
 * @param {string} [params.title]             - Meeting title (defaults to "Meeting with {name}")
 * @param {number} [params.durationMinutes=30] - Event duration in minutes
 * @returns {Promise<{success: boolean, eventLink: string, eventId: string}>}
 */
async function createEvent({ name, dateTime, title, durationMinutes = 30, timezone = 'UTC' }) {
  if (!name || !dateTime) {
    throw new Error('name and dateTime are required parameters');
  }

  const startTime = new Date(dateTime);
  if (isNaN(startTime.getTime())) {
    throw new Error(`Invalid dateTime format: "${dateTime}". Expected ISO 8601.`);
  }

  const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);
  const eventTitle = title || `Meeting with ${name}`;
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

  const calendar = getCalendarClient();

  const event = {
    summary: eventTitle,
    description: `Scheduled by voice assistant for ${name}`,
    start: {
      dateTime: startTime.toISOString(),
      timeZone: timezone,
    },
    end: {
      dateTime: endTime.toISOString(),
      timeZone: timezone,
    },
  };

  try {
    const response = await calendar.events.insert({
      calendarId,
      requestBody: event,
    });

    return {
      success: true,
      eventLink: response.data.htmlLink,
      eventId: response.data.id,
    };
  } catch (err) {
    throw new Error(`Google Calendar API error: ${err.message}`);
  }
}

module.exports = { createEvent };
