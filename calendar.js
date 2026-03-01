'use strict';

const { google } = require('googleapis');

/**
 * Create a calendar event using the signed-in user's OAuth access token.
 * Events are created on the user's own primary Google Calendar.
 *
 * @param {Object} params
 * @param {string} params.accessToken          - User's OAuth access token
 * @param {string} params.name                 - Attendee name (used in description)
 * @param {string} params.dateTime             - ISO 8601 datetime string e.g. "2026-03-15T10:00:00Z"
 * @param {string} [params.title]              - Meeting title (defaults to "Meeting with {name}")
 * @param {number} [params.durationMinutes=30] - Duration in minutes
 * @param {string} [params.timezone='UTC']     - IANA timezone string
 * @returns {Promise<{success: boolean, eventLink: string, eventId: string}>}
 */
async function createEventWithToken({ accessToken, name, dateTime, title, durationMinutes = 30, timezone = 'UTC' }) {
  if (!accessToken) throw new Error('accessToken is required');
  if (!name || !dateTime) throw new Error('name and dateTime are required');

  const startTime = new Date(dateTime);
  if (isNaN(startTime.getTime())) {
    throw new Error(`Invalid dateTime format: "${dateTime}". Expected ISO 8601.`);
  }

  const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);
  const eventTitle = title || `Meeting with ${name}`;

  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });

  const calendar = google.calendar({ version: 'v3', auth });

  try {
    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: eventTitle,
        description: `Scheduled by voice assistant for ${name}`,
        start: { dateTime: startTime.toISOString(), timeZone: timezone },
        end:   { dateTime: endTime.toISOString(),   timeZone: timezone },
      },
    });

    return {
      success: true,
      eventLink: response.data.htmlLink,
      eventId:   response.data.id,
    };
  } catch (err) {
    if (err.code === 401) {
      throw new Error('Google access token expired. Please sign in again.');
    }
    throw new Error(`Google Calendar API error: ${err.message}`);
  }
}

module.exports = { createEventWithToken };
